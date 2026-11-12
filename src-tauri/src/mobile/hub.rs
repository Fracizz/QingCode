//! Hub 的会话/设备/视图管理，以及向前端与手机派发输出、屏幕、退出和控制事件。

use super::*;

pub(super) fn prune(attempts: &mut VecDeque<Instant>, now: Instant) {
    while attempts
        .front()
        .is_some_and(|time| now.duration_since(*time) >= ATTEMPT_WINDOW)
    {
        attempts.pop_front();
    }
}

pub(super) fn remove_attempt(attempts: &mut VecDeque<Instant>, time: Instant) {
    if let Some(index) = attempts.iter().position(|item| *item == time) {
        attempts.remove(index);
    }
}

impl Hub {
    pub(super) fn load(&self, settings: &SavedSettings) {
        let mut inner = self.inner.lock().unwrap();
        inner.configured = true;
        inner.enabled = settings.enabled;
        inner.saved_port = Some(settings.endpoint.port());
        inner.fingerprint = Some(fingerprint(&settings.certificate));
        inner.code = Some(settings.code.clone());
        inner.desktop_terminals = settings.desktop_terminals;
        let previous: HashMap<String, Option<Instant>> = inner
            .devices
            .drain(..)
            .map(|entry| (entry.saved.id, entry.last_seen))
            .collect();
        inner.devices = settings
            .devices
            .iter()
            .map(|device| DeviceEntry {
                saved: device.clone(),
                last_seen: previous.get(&device.id).copied().flatten(),
            })
            .collect();
    }

    /// Reserves a pairing attempt before the expensive code check runs unlocked.
    pub(super) fn begin_pair(&self, peer: IpAddr, now: Instant) -> Result<CodeVerifier, String> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.accepting {
            return Err("移动连接已停止。".into());
        }
        if inner.devices.len() >= MAX_DEVICES {
            return Err("已配对设备已达上限，请先在 Windows 端移除不用的设备。".into());
        }
        let code = inner.code.clone().ok_or("移动连接尚未设置密码。")?;
        prune(&mut inner.total_attempts, now);
        inner.attempts.retain(|_, attempts| {
            prune(attempts, now);
            !attempts.is_empty()
        });
        let peer_attempts = inner.attempts.get(&peer).map_or(0, VecDeque::len);
        if peer_attempts >= MAX_PEER_ATTEMPTS || inner.total_attempts.len() >= MAX_TOTAL_ATTEMPTS {
            return Err("密码尝试过多，请在一分钟后重试。".into());
        }
        inner.attempts.entry(peer).or_default().push_back(now);
        inner.total_attempts.push_back(now);
        Ok(code)
    }

    pub(super) fn finish_pair(
        &self,
        peer: IpAddr,
        started: Instant,
        name: Option<&str>,
    ) -> Result<(String, Device), String> {
        let mut inner = self.inner.lock().unwrap();
        inner.attempts.remove(&peer);
        remove_attempt(&mut inner.total_attempts, started);
        if !inner.accepting {
            return Err("移动连接已停止。".into());
        }
        if inner.devices.len() >= MAX_DEVICES {
            return Err("已配对设备已达上限，请先在 Windows 端移除不用的设备。".into());
        }
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let device = Device {
            id: Uuid::new_v4().to_string(),
            name: device_name(name),
            token_digest: token_digest(&token),
            paired_at: unix_now(),
        };
        inner.devices.push(DeviceEntry {
            saved: device.clone(),
            last_seen: Some(Instant::now()),
        });
        Ok((token, device))
    }

    pub(super) fn pair(
        &self,
        peer: IpAddr,
        secret: &str,
        name: Option<&str>,
        persist: impl FnOnce(&Device) -> Result<(), String>,
    ) -> Result<String, String> {
        let started = Instant::now();
        let code = self.begin_pair(peer, started)?;
        if !code.matches(secret) {
            return Err("密码不正确。".into());
        }
        let (token, device) = self.finish_pair(peer, started, name)?;
        if let Err(error) = persist(&device) {
            self.forget_device(&device.id);
            return Err(format!("保存配对失败：{error}"));
        }
        Ok(token)
    }

    /// Removes a device and returns the live sessions it created.
    pub(super) fn forget_device(&self, id: &str) -> Vec<(String, ProjectKind)> {
        let mut inner = self.inner.lock().unwrap();
        inner.devices.retain(|entry| entry.saved.id != id);
        let owned: Vec<String> = inner
            .sessions
            .iter()
            // Invalidate reservations too; late spawns must close their PTY.
            .filter(|(_, session)| session.owner == id)
            .map(|(session_id, _)| session_id.clone())
            .collect();
        owned
            .into_iter()
            .filter_map(|session_id| {
                let session = inner.sessions.remove(&session_id)?;
                (session.ready && session.exit.is_none())
                    .then_some((session_id, session.project.kind))
            })
            .collect()
    }

    /// Returns the device id. A stopped endpoint answers 503 so phones keep their
    /// pairing; only an unknown token is reported as revoked (401).
    pub(super) fn authenticate(
        &self,
        bearer: Option<&str>,
    ) -> Result<String, (StatusCode, String)> {
        let digest = bearer.map(token_digest);
        let mut inner = self.inner.lock().unwrap();
        if !inner.accepting {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Windows 端已停止移动连接。".into(),
            ));
        }
        if let Some(digest) = digest {
            let mut found = None;
            // Compare every digest so timing does not reveal the matching slot.
            for entry in &mut inner.devices {
                if bool::from(entry.saved.token_digest.ct_eq(&digest)) {
                    entry.last_seen = Some(Instant::now());
                    found = Some(entry.saved.id.clone());
                }
            }
            if let Some(id) = found {
                return Ok(id);
            }
        }
        Err((StatusCode::UNAUTHORIZED, "配对已失效，请重新配对。".into()))
    }

    pub(super) fn session_kind(&self, id: &str) -> Result<ProjectKind, String> {
        let inner = self.inner.lock().unwrap();
        let session = inner.live(id).ok_or("终端不存在。")?;
        if !session.ready || session.dormant || session.exit.is_some() || !inner.accepting {
            return Err("终端已结束或正在启动。".into());
        }
        Ok(session.project.kind)
    }

    /// 取出空闲超过 `limit` 的在线会话（标记为关闭中，由调用方结束），并直接移除早已结束的记录。
    pub(super) fn take_idle_sessions(&self, limit: Duration) -> Vec<(String, ProjectKind)> {
        let mut inner = self.inner.lock().unwrap();
        inner.sessions.retain(|_, session| {
            !(session.ready && session.exit.is_some() && session.last_active.elapsed() >= limit)
        });
        // 镜像只回收记录，绝不返回给调用方结束进程。
        inner.mirrors.retain(|_, mirror| {
            !((mirror.dormant || mirror.exit.is_some()) && mirror.last_active.elapsed() >= limit)
        });
        inner
            .sessions
            .iter_mut()
            .filter(|(_, session)| {
                session.ready && session.exit.is_none() && session.last_active.elapsed() >= limit
            })
            .map(|(id, session)| {
                session.ready = false;
                (id.clone(), session.project.kind)
            })
            .collect()
    }

    pub(super) fn reserve_session(
        &self,
        id: String,
        project: Project,
        device: &str,
        label: Option<String>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        require_device(&inner, device)?;
        if inner.sessions.len() >= MAX_SESSIONS {
            return Err("终端数量已达上限，请结束闲置会话。".into());
        }
        inner.next_number += 1;
        let mut session = Session::new(project, device.to_string(), inner.next_number);
        session.label = label;
        inner.sessions.insert(id, session);
        Ok(())
    }

    /// A false result makes the caller close a successfully spawned PTY whose
    /// reservation was cancelled during a native/remote launch.
    pub(super) fn finish_create(&self, id: &str, succeeded: bool) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let authorized = inner
            .sessions
            .get(id)
            .is_some_and(|session| require_device(&inner, &session.owner).is_ok());
        if !succeeded || !authorized {
            // 保留 pending_names：这次没接回，下一轮扫描还要用。
            inner.sessions.remove(id);
            return false;
        }
        inner.sessions.get_mut(id).unwrap().ready = true;
        inner.pending_names.remove(id);
        true
    }

    /// 载入上次保存的名称并淘汰过期记录。新终端的编号排在待接回的之后，不会撞号。
    pub(super) fn load_session_names(&self, saved: HashMap<String, SavedSessionName>, now_ms: u64) {
        let mut inner = self.inner.lock().unwrap();
        for (id, mut name) in saved {
            let since = *name.detached_since_ms.get_or_insert(now_ms);
            if now_ms.saturating_sub(since) < SAVED_NAME_RETENTION.as_millis() as u64 {
                inner.next_number = inner.next_number.max(name.number);
                inner.pending_names.insert(id, name);
            }
        }
    }

    /// 需要落盘的名称：能在电脑重启后接回的在线会话，加上还没接回的记录。
    /// 已结束或被关闭的会话不在其中，记录随下一次写入消失。
    pub(super) fn session_names_snapshot(&self) -> HashMap<String, SavedSessionName> {
        let inner = self.inner.lock().unwrap();
        let mut names = inner.pending_names.clone();
        names.extend(
            inner
                .sessions
                .iter()
                .filter(|(_, session)| {
                    session.ready
                        && session.project.kind == ProjectKind::Ssh
                        && session.exit.as_ref().is_none_or(|exit| exit.disconnected)
                })
                .map(|(id, session)| (id.clone(), session.saved_name())),
        );
        names
    }

    /// 接回时恢复名称。版本号改用当前时间：手机可能还留着重启前较大的版本号，
    /// 从 0 重新计数的名称会被它当成迟到的旧响应丢弃。
    pub(super) fn restore_session_name(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        let saved = inner.pending_names.get(id).cloned();
        if let Some(session) = inner.sessions.get_mut(id) {
            if let Some(saved) = saved {
                session.restore_name(saved);
            }
            session.name_revision = unix_now_ms();
        }
    }

    /// 单飞且限频；返回 false 表示这次不用扫描。
    pub(super) fn begin_restore_scan(&self, now: Instant) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let throttled = inner
            .restore
            .last_started
            .is_some_and(|last| now.saturating_duration_since(last) < RESTORE_SCAN_INTERVAL);
        if !inner.accepting || inner.restore.running || throttled {
            return false;
        }
        inner.restore.running = true;
        inner.restore.last_started = Some(now);
        true
    }

    pub(super) fn finish_restore_scan(&self, connect_requested: bool, finished: Vec<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.restore.running = false;
        inner.restore.connect_requested |= connect_requested;
        inner.restore.finished.extend(finished);
    }

    pub(super) fn restore_connect_requested(&self) -> bool {
        self.inner.lock().unwrap().restore.connect_requested
    }

    pub(super) fn restore_finished(&self, connection: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .restore
            .finished
            .contains(connection)
    }

    pub(super) fn take_live_sessions(&self) -> Vec<(String, ProjectKind)> {
        let sessions = std::mem::take(&mut self.inner.lock().unwrap().sessions);
        sessions
            .into_iter()
            .filter(|(_, session)| session.ready && session.exit.is_none())
            .map(|(id, session)| (id, session.project.kind))
            .collect()
    }

    pub(super) fn with_session(&self, id: &str, update: impl FnOnce(&mut Session)) {
        if let Some(session) = self.inner.lock().unwrap().live_mut(id) {
            update(session);
        }
    }

    pub(super) fn desktop_terminals_enabled(&self) -> bool {
        self.inner.lock().unwrap().desktop_terminals
    }

    /// Writes are bound to the authenticated controller. Legacy phones can omit
    /// the lease only on a phone session they currently control.
    pub(super) fn authorize(
        &self,
        id: &str,
        device: &str,
        lease: Option<u64>,
    ) -> Result<(), String> {
        let inner = self.inner.lock().unwrap();
        require_device(&inner, device)?;
        let session = inner.live(id).ok_or("终端不存在。")?;
        let valid_lease =
            lease.map_or_else(|| inner.sessions.contains_key(id), |n| n == session.lease);
        if !session.dormant
            && valid_lease
            && matches!(&session.controller, Controller::Device(holder) if holder == device)
        {
            Ok(())
        } else {
            Err(TAKEN_OVER.into())
        }
    }

    /// 取得或确认使用权。已持有时返回原编号；被占用且 `take` 为 false 时返回被接管答复。
    pub(super) fn claim(&self, id: &str, device: &str, take: bool) -> Result<Value, String> {
        let mut inner = self.inner.lock().unwrap();
        require_device(&inner, device)?;
        let controller = Controller::Device(device.to_string());
        let session = inner
            .live(id)
            .filter(|session| session.ready && !session.dormant)
            .ok_or("终端不存在。")?;
        if session.controller == controller {
            return Ok(json!({ "lease": session.lease }));
        }
        if !take {
            let by = inner.controller_name(&session.controller);
            return Ok(json!({ "takenOver": true, "by": by }));
        }
        let session = inner.live_mut(id).ok_or("终端不存在。")?;
        session.controller = controller;
        session.lease += 1;
        // 叫醒长轮询，被顶下去的设备立刻收到答复。
        session.changed.notify_waiters();
        Ok(json!({ "lease": session.lease }))
    }

    pub(super) fn mirror_active(&self, id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .mirrors
            .get(id)
            .is_some_and(|mirror| !mirror.dormant)
    }

    pub(super) fn is_phone_session(&self, id: &str) -> bool {
        self.inner.lock().unwrap().sessions.contains_key(id)
    }

    /// 用电脑当前画面建立镜像；编号沿用旧表项，迟到的手机请求不会误通过。
    #[allow(clippy::too_many_arguments)]
    pub(super) fn seed_mirror(
        &self,
        id: String,
        project: Project,
        device: &str,
        name: Option<String>,
        cols: u16,
        rows: u16,
        data: &str,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        require_device(&inner, device)?;
        if !inner.desktop_terminals {
            return Err("电脑端未开启手机接入电脑终端。".into());
        }
        let mut session = Session::new(project, device.to_string(), 0);
        if let Some(previous) = inner.mirrors.get(&id) {
            session.lease = previous.lease + 1;
            // A resumed viewer with the old output cursor must get this new snapshot.
            session.next = previous.next + 1;
        }
        session.ready = true;
        session.controller = Controller::Desktop;
        session.label = name;
        let (cols, rows) = size(cols, rows);
        session.screen.resize(cols, rows);
        session.screen.process(data.as_bytes());
        inner.mirrors.insert(id, session);
        Ok(())
    }

    pub(super) fn mirror_push(&self, id: &str, chunk: OutputChunk) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(mirror) = inner.mirrors.get_mut(id).filter(|mirror| !mirror.dormant) {
            mirror.push(chunk);
        }
    }

    pub(super) fn mirror_finish(&self, id: &str, exit: Exit) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(mirror) = inner.mirrors.get_mut(id).filter(|mirror| !mirror.dormant) {
            mirror.finish(exit);
        }
    }

    /// 让出手机设备的镜像（全部或指定设备），返回受影响的终端，由调用方通知电脑端恢复操作。
    pub(super) fn release_mirrors(&self, device: Option<&str>) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap();
        inner
            .mirrors
            .iter_mut()
            .filter(|(_, mirror)| {
                !mirror.dormant
                    && device.is_none_or(|device| {
                        mirror.controller == Controller::Device(device.to_string())
                    })
            })
            .map(|(id, mirror)| {
                if device.is_some() {
                    mirror.controller = Controller::Desktop;
                    mirror.lease += 1;
                    mirror.changed.notify_waiters();
                } else {
                    mirror.release_mirror();
                }
                id.clone()
            })
            .collect()
    }

    pub(super) fn take_for_desktop(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner.live_mut(id).ok_or("终端不存在。")?;
        if session.controller != Controller::Desktop {
            session.controller = Controller::Desktop;
            session.lease += 1;
            session.changed.notify_waiters();
        }
        Ok(())
    }

    /// 给电脑终端列表补上当前使用者。
    pub(super) fn annotate_desktop_terminals(&self, items: Vec<Value>, viewer: &str) -> Vec<Value> {
        let inner = self.inner.lock().unwrap();
        items
            .into_iter()
            .filter_map(|mut item| {
                let id = item.get("id")?.as_str()?.to_owned();
                let holder = inner
                    .mirrors
                    .get(&id)
                    .filter(|mirror| !mirror.dormant && mirror.exit.is_none())
                    .map_or(Controller::Desktop, |mirror| mirror.controller.clone());
                let name = inner.controller_name(&holder);
                let map = item.as_object_mut()?;
                map.insert("origin".into(), json!("desktop"));
                map.insert("number".into(), json!(0));
                map.insert("exit".into(), Value::Null);
                map.insert("controllerName".into(), json!(name));
                map.insert(
                    "inUseHere".into(),
                    json!(holder == Controller::Device(viewer.to_string())),
                );
                Some(item)
            })
            .collect()
    }

    /// 开始在电脑标签中查看手机终端；首次发送整屏快照，之后走增量。
    pub(super) fn open_view(&self, id: &str) -> Result<Value, String> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner
            .sessions
            .get(id)
            .filter(|session| session.ready)
            .ok_or("终端不存在。")?;
        let (cols, rows) = session.screen.size();
        let holder = (session.controller != Controller::Desktop)
            .then(|| inner.controller_name(&session.controller));
        let reply = json!({
            "name": session.name(), "projectId": session.project.id, "path": session.project.path,
            "kind": session.project.kind, "controller": holder, "cols": cols, "rows": rows,
            "exit": session.exit,
        });
        inner.desktop_views.insert(id.to_string());
        if let Some(session) = inner.sessions.get_mut(id) {
            session.view = Some(ViewBacklog {
                bytes: Vec::new(),
                snapshot: true,
            });
        }
        Ok(reply)
    }

    pub(super) fn close_view(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.desktop_views.remove(id);
        if let Some(session) = inner.sessions.get_mut(id) {
            session.view = None;
        }
    }

    pub(super) fn desktop_controls(&self, id: &str) -> Result<ProjectKind, String> {
        let inner = self.inner.lock().unwrap();
        let session = inner.sessions.get(id).ok_or("终端不存在。")?;
        if session.controller != Controller::Desktop {
            return Err(TAKEN_OVER.into());
        }
        if !session.ready || session.exit.is_some() {
            return Err("终端已结束或正在启动。".into());
        }
        Ok(session.project.kind)
    }

    /// 取出待发给电脑标签的内容：积压过多时给整屏快照，并附带退出信息。
    pub(super) fn take_view_output(&self, id: &str) -> Option<(ViewOutput, Option<(u32, bool)>)> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner.sessions.get_mut(id)?;
        let exit = session
            .exit
            .as_ref()
            .map(|exit| (exit.exit_code, exit.disconnected));
        let output = if session.view.as_ref()?.snapshot {
            let screen = session.screen.snapshot();
            let view = session.view.as_mut()?;
            view.snapshot = false;
            view.bytes = Vec::new();
            ViewOutput::Screen(screen)
        } else {
            ViewOutput::Bytes(std::mem::take(&mut session.view.as_mut()?.bytes))
        };
        Some((output, exit))
    }

    pub(super) fn take_view_mark(&self, id: &str) -> bool {
        self.inner.lock().unwrap().desktop_views.remove(id)
    }

    /// 更新会话画面。返回 true 表示调用方需要安排一次预览通知；
    /// 通知发出前的后续更新只返回 false，由已安排的那次一并覆盖。
    pub(super) fn update_for_preview(&self, id: &str, update: impl FnOnce(&mut Session)) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(session) = inner.sessions.get_mut(id) else {
            return false;
        };
        update(session);
        !std::mem::replace(&mut session.preview_notify_pending, true)
    }

    pub(super) fn rename_session(&self, id: &str, name: &str) -> Result<Value, String> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner.sessions.get_mut(id).ok_or("终端不存在。")?;
        if !session.ready {
            return Err("终端正在启动或关闭。".into());
        }
        session.rename(name)?;
        Ok(session.metadata(id))
    }

    /// 全部已就绪的手机会话，附项目与创建设备，按项目名、编号排序。
    /// viewer 为请求的手机设备时额外标出 `ownDevice`（是否由这台手机创建）。
    pub(super) fn session_summaries(&self, viewer: Option<&str>) -> Vec<Value> {
        let inner = self.inner.lock().unwrap();
        let mut sessions: Vec<_> = inner
            .sessions
            .iter()
            .filter(|(_, session)| session.ready)
            .collect();
        sessions.sort_by(|(_, a), (_, b)| {
            (a.project.name.as_str(), a.project.id.as_str(), a.number).cmp(&(
                b.project.name.as_str(),
                b.project.id.as_str(),
                b.number,
            ))
        });
        sessions
            .into_iter()
            .map(|(id, session)| {
                let device = inner
                    .devices
                    .iter()
                    .find(|entry| entry.saved.id == session.owner);
                let mut value = session.metadata(id);
                if let Value::Object(map) = &mut value {
                    map.insert(
                        "project".into(),
                        json!({
                            "id": session.project.id, "name": session.project.name,
                            "path": session.project.path, "kind": session.project.kind,
                            "host": session.project.host,
                        }),
                    );
                    map.insert(
                        "deviceName".into(),
                        json!(device.map(|entry| entry.saved.name.as_str())),
                    );
                    map.insert(
                        "controllerName".into(),
                        json!(inner.controller_name(&session.controller)),
                    );
                    if let Some(viewer) = viewer {
                        map.insert("ownDevice".into(), json!(session.owner == viewer));
                        map.insert(
                            "inUseHere".into(),
                            json!(session.controller == Controller::Device(viewer.to_string())),
                        );
                    }
                }
                value
            })
            .collect()
    }

    pub(super) fn session_preview(&self, id: &str) -> Result<Value, String> {
        let inner = self.inner.lock().unwrap();
        let session = inner
            .sessions
            .get(id)
            .filter(|session| session.ready)
            .ok_or("终端不存在。")?;
        let mut preview = session.screen.preview(PREVIEW_HISTORY_LINES);
        if let Value::Object(map) = &mut preview {
            map.insert("name".into(), json!(session.name()));
            map.insert("exit".into(), json!(session.exit));
        }
        Ok(preview)
    }

    #[cfg(test)]
    pub(super) fn holds(&self, id: &str) -> bool {
        self.inner.lock().unwrap().sessions.contains_key(id)
    }
}

pub(crate) fn is_mobile_terminal(id: &str) -> bool {
    id.starts_with(TERMINAL_PREFIX)
}

/// 更新手机会话，并在合并间隔结束时通知电脑端预览。
/// 通知排在间隔末尾，一段输出的最后一块也能被预览读到；
/// 没有预览在监听时，Tauri 不会把事件发给 webview。
pub(super) fn deliver_update(app: &AppHandle, id: &str, update: impl FnOnce(&mut Session)) {
    let Some(state) = app.try_state::<MobileState>() else {
        return;
    };
    if !state.hub.update_for_preview(id, update) {
        return;
    }
    schedule_output_notify(app.clone(), id.to_owned());
}

/// 合并间隔结束后发给电脑标签与预览，电脑端比手机晚约 100ms 显示，换取较低的刷新开销。
pub(super) fn schedule_output_notify(app: AppHandle, id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PREVIEW_NOTIFY_INTERVAL).await;
        // 先清标记再发事件：之后到达的输出会再安排一次通知，不会漏掉。
        if let Some(state) = app.try_state::<MobileState>() {
            state.hub.with_session(&id, |session| {
                session.preview_notify_pending = false;
            });
        }
        flush_view(&app, &id);
        let _ = app.emit(PREVIEW_OUTPUT_EVENT, json!({ "id": id }));
    });
}

pub(super) enum ViewOutput {
    Bytes(Vec<u8>),
    Screen(Value),
}

/// 把积压的手机终端输出交给电脑标签，事件名与普通终端相同，电脑端无需另写渲染。
pub(super) fn flush_view(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<MobileState>() else {
        return;
    };
    let Some((output, exit)) = state.hub.take_view_output(id) else {
        return;
    };
    match output {
        ViewOutput::Bytes(bytes) if bytes.is_empty() => {}
        ViewOutput::Bytes(bytes) => {
            let data = crate::terminal::encode_terminal_data(&bytes);
            let _ = app.emit("terminal-data", json!({ "id": id, "data": data }));
        }
        ViewOutput::Screen(mut screen) => {
            screen["id"] = json!(id);
            let _ = app.emit("terminal-screen", screen);
        }
    }
    if let Some((exit_code, disconnected)) = exit {
        emit_view_exit(app, id, exit_code, disconnected);
    }
}

/// 只通知一次：退出事件和各条移除路径都可能走到这里。
pub(super) fn emit_view_exit(app: &AppHandle, id: &str, exit_code: u32, disconnected: bool) {
    let Some(state) = app.try_state::<MobileState>() else {
        return;
    };
    if state.hub.take_view_mark(id) {
        let _ = app.emit(
            "terminal-exit",
            json!({ "id": id, "exitCode": exit_code, "disconnected": disconnected }),
        );
    }
}

pub(super) fn emit_control(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<MobileState>() else {
        return;
    };
    let payload = {
        let inner = state.hub.inner.lock().unwrap();
        let Some(session) = inner.live(id) else {
            return;
        };
        let holder = (session.controller != Controller::Desktop && !session.dormant)
            .then(|| inner.controller_name(&session.controller));
        let (cols, rows) = session.screen.size();
        json!({ "id": id, "controller": holder, "cols": cols, "rows": rows,
            "mirroring": inner.mirrors.contains_key(id) && !session.dormant })
    };
    let _ = app.emit(CONTROL_EVENT, payload);
}

/// Base64 PTY output for a `mobile-*` terminal.
pub(crate) fn deliver_data(app: &AppHandle, id: &str, data: String) {
    deliver_update(app, id, |session| session.push(OutputChunk::Bytes(data)));
}

/// Plain-text screen snapshot for a reattached `mobile-*` daemon terminal.
pub(crate) fn deliver_screen(app: &AppHandle, id: &str, data: String, cols: u16, rows: u16) {
    deliver_update(app, id, |session| {
        session.push(OutputChunk::Screen { data, cols, rows })
    });
}

pub(crate) fn deliver_exit(app: &AppHandle, id: &str, exit_code: u32, disconnected: bool) {
    deliver_update(app, id, |session| {
        session.finish(Exit {
            exit_code,
            disconnected,
        })
    });
}

/// 定期结束空闲超过 24 小时的手机终端；结束失败的会话恢复原状，下一轮再试。
pub(super) async fn sweep_idle_terminals(app: &AppHandle) {
    let hub = &app.state::<MobileState>().inner().hub;
    let unused = {
        let mut inner = hub.inner.lock().unwrap();
        inner
            .mirrors
            .iter_mut()
            .filter_map(|(id, mirror)| {
                if mirror.dormant
                    || mirror.controller != Controller::Desktop
                    || mirror.last_viewed.elapsed() < Duration::from_secs(60)
                {
                    return None;
                }
                mirror.release_mirror();
                Some(id.clone())
            })
            .collect::<Vec<_>>()
    };
    for id in unused {
        emit_control(app, &id);
    }
    for (id, kind) in hub.take_idle_sessions(TERMINAL_IDLE) {
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
    }
}
