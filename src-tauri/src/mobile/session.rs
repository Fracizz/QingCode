//! 手机端终端会话：项目描述、会话状态、输出缓冲与退出信息。

use super::*;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Project {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) path: String,
    pub(super) kind: ProjectKind,
    pub(super) host: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum ProjectKind {
    Local,
    Wsl,
    Ssh,
}

/// 随电脑重启保留的手机会话名称信息，接回时按会话 id 恢复。
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct SavedSessionName {
    pub(super) number: u64,
    pub(super) custom_name: Option<String>,
    pub(super) label: Option<String>,
    /// 去掉转圈帧的程序标题。daemon 的屏幕快照不带标题，接回后只能靠这里。
    pub(super) title: Option<String>,
    pub(super) created_at_ms: u64,
    /// 开始等待接回的时间（Unix 毫秒），用于淘汰再也接不回的记录；在线会话为空。
    pub(super) detached_since_ms: Option<u64>,
}

pub(super) struct Session {
    pub(super) project: Project,
    pub(super) owner: String,
    pub(super) number: u64,
    pub(super) custom_name: Option<String>,
    /// 带启动命令的终端配置名；程序未设置标题时代替「终端 N」。
    pub(super) label: Option<String>,
    /// 重启前最后的程序标题，程序发出新标题后不再使用。
    pub(super) restored_title: Option<String>,
    pub(super) name_revision: u64,
    pub(super) activity_revision: AtomicU64,
    pub(super) ready: bool,
    pub(super) exit: Option<Exit>,
    pub(super) drain_until: Option<Instant>,
    pub(super) output: VecDeque<OutputChunk>,
    pub(super) output_size: usize,
    pub(super) next: u64,
    pub(super) changed: Arc<Notify>,
    pub(super) screen: MobileScreen,
    /// 最近一次输入或输出；轮询不算活动。
    pub(super) last_active: Instant,
    pub(super) last_active_ms: u64,
    /// 会话创建时间（Unix 毫秒），供手机与电脑端「终端管理」显示。
    pub(super) created_at_ms: u64,
    /// 最近一次程序标题转圈帧的时间，用于平滑的「忙碌」状态。
    pub(super) last_spinner_frame: Option<Instant>,
    /// 最近一次输入或改尺寸，其后短时间内的输出视为回显/重绘。
    pub(super) last_input: Option<Instant>,
    /// 当前这段连续输出的开始与最近一次（间隔达到 `SPINNER_HOLD` 即断开）。
    pub(super) output_streak_start: Option<Instant>,
    pub(super) last_output: Option<Instant>,
    /// 空闲时改尺寸开始的重绘段（开始、最近一块输出），其中的输出不算工作。
    pub(super) redraw: Option<(Instant, Instant)>,
    /// 已安排一次预览通知且尚未发出。
    pub(super) preview_notify_pending: bool,
    /// 多端共享状态：独占、尺寸方、在线设备与输入来源。
    pub(super) sharing: Sharing,
    /// 独占权编号，每次有一方取得独占加一；旧版手机据此判断自己是否被接管。
    pub(super) lease: u64,
    /// 串行化写入与改尺寸：一条输入整体写完，才处理下一条或改尺寸。
    pub(super) control_gate: Arc<tokio::sync::Mutex<()>>,
    /// 新建时领取了电脑端的预热终端；手机在标题旁显示 ⚡。
    pub(super) prewarm_hit: bool,
    /// 电脑终端镜像已通过电脑端检查（已信任项目里的交互式终端），手机可以接入。
    pub(super) approved: bool,
    /// 电脑终端镜像从终端启动或整屏快照开始记录，画面完整；否则接入时向电脑要一次当前画面。
    pub(super) complete: bool,
    /// 上次通知时的共享状态摘要，用于判断是否需要再通知。
    pub(super) presence_signature: u64,
    pub(super) view: Option<ViewBacklog>,
}

impl Session {
    /// 独占与接管共用同一次控制权、尺寸权变更，忽略尺寸锁。
    pub(super) fn take_exclusive(&mut self, who: Controller) -> Option<(u16, u16)> {
        let mut resize = None;
        if self.sharing.size_owner != who {
            if self.exit.is_none() {
                resize = self.sharing.sizes.get(&who).copied();
            }
            self.sharing.size_owner = who.clone();
        }
        if self.sharing.exclusive.as_ref() != Some(&who) {
            self.sharing.exclusive = Some(who);
            self.lease += 1;
        }
        resize
    }

    pub(super) fn new(project: Project, owner: String, number: u64) -> Self {
        let now_ms = unix_now_ms();
        let mut sharing = Sharing::new(Controller::Device(owner.clone()));
        sharing.see_device(&owner, None, Instant::now());
        Self {
            project,
            sharing,
            lease: 1,
            control_gate: Arc::default(),
            prewarm_hit: false,
            approved: false,
            complete: false,
            presence_signature: 0,
            view: None,
            owner,
            number,
            custom_name: None,
            label: None,
            restored_title: None,
            name_revision: 0,
            activity_revision: AtomicU64::new(0),
            ready: false,
            exit: None,
            drain_until: None,
            output: VecDeque::new(),
            output_size: 0,
            next: 0,
            changed: Arc::new(Notify::new()),
            screen: MobileScreen::new(),
            last_active: Instant::now(),
            last_active_ms: now_ms,
            created_at_ms: now_ms,
            last_spinner_frame: None,
            last_input: None,
            output_streak_start: None,
            last_output: None,
            redraw: None,
            preview_notify_pending: false,
        }
    }

    /// 程序是否在忙：有 OSC 7501 上报时以上报为准，否则看标题仍是转圈帧或最近
    /// `SPINNER_HOLD` 内出现过转圈帧；终端退出后一律不忙。
    pub(super) fn program_busy_at(&self, now: Instant) -> bool {
        if let Some(state) = self.screen.program_state() {
            return self.exit.is_none() && state == ProgramState::Working;
        }
        self.exit.is_none()
            && (self
                .screen
                .title()
                .and_then(|title| title.chars().next())
                .is_some_and(is_spinner_glyph)
                || self
                    .last_spinner_frame
                    .is_some_and(|frame| now.saturating_duration_since(frame) < SPINNER_HOLD))
    }

    pub(super) fn program_busy(&self) -> bool {
        self.program_busy_at(Instant::now())
    }

    /// 持续输出（连续至少 `OUTPUT_STREAK`，且最近 `SPINNER_HOLD` 内仍有输出）。
    /// 覆盖 build / test 等不改标题的命令；只用于列表显示，后台提醒仍只看标题转圈，
    /// 免得 `tail -f` 这类间歇输出反复触发「已停下」通知。
    pub(super) fn output_busy_at(&self, now: Instant) -> bool {
        if self.screen.program_state().is_some() {
            return false;
        }
        self.exit.is_none()
            && match (self.output_streak_start, self.last_output) {
                (Some(start), Some(last)) => {
                    now.saturating_duration_since(last) < SPINNER_HOLD
                        && last.saturating_duration_since(start) >= OUTPUT_STREAK
                }
                _ => false,
            }
    }

    /// 列表显示与排序用的「运行中」：标题转圈或持续输出。
    pub(super) fn display_busy(&self) -> bool {
        let now = Instant::now();
        self.program_busy_at(now) || self.output_busy_at(now)
    }

    /// 交互回显只短暂合并同一帧的分片；持续的后台输出仍按普通窗口合并。
    pub(super) fn output_coalesce_delay(&self, now: Instant) -> Duration {
        if self
            .last_input
            .is_some_and(|at| now.saturating_duration_since(at) < OUTPUT_QUIET_AFTER_INPUT)
        {
            Duration::from_millis(6)
        } else {
            OUTPUT_COALESCE
        }
    }

    /// 键盘输入：既算会话活动，也让随后的回显不计入输出活跃；结束重绘段。
    pub(super) fn note_input(&mut self) {
        self.touch();
        self.last_input = Some(self.last_active);
        self.redraw = None;
    }

    /// 改尺寸：TUI 随后整屏重绘（Claude Code 会重印全部对话，可持续数秒）。
    /// 空闲时整段重绘不算工作；正在持续输出时不开启，免得吞掉真实工作的输出。
    pub(super) fn note_resize(&mut self) {
        self.touch();
        let now = self.last_active;
        self.last_input = Some(now);
        if self.output_busy_at(now) {
            return;
        }
        self.redraw = Some(self.redraw.map_or((now, now), |(start, _)| (start, now)));
    }

    /// 用户输入：回车提交时作废之前的上报（可能来自已退出的程序），由程序重新上报。
    pub(super) fn note_user_input(&mut self, data: &str) {
        self.note_input();
        if data.contains('\r') {
            self.screen.clear_program_state();
        }
    }

    pub(super) fn note_output_at(&mut self, now: Instant) {
        if let Some((start, last)) = self.redraw {
            if now.saturating_duration_since(last) <= REDRAW_GAP
                && now.saturating_duration_since(start) <= REDRAW_MAX
            {
                self.redraw = Some((start, now));
                return;
            }
            self.redraw = None;
        }
        if self
            .last_input
            .is_some_and(|input| now.saturating_duration_since(input) < OUTPUT_QUIET_AFTER_INPUT)
        {
            return;
        }
        if self
            .last_output
            .is_none_or(|last| now.saturating_duration_since(last) >= SPINNER_HOLD)
        {
            self.output_streak_start = Some(now);
        }
        self.last_output = Some(now);
    }

    pub(super) fn touch(&mut self) {
        self.last_active = Instant::now();
        self.last_active_ms = unix_now_ms();
    }

    /// 电脑终端的镜像：尺寸跟随电脑，项目信息在电脑端检查通过后补上。
    pub(super) fn mirror() -> Self {
        let project = Project {
            id: String::new(),
            name: String::new(),
            path: String::new(),
            kind: ProjectKind::Local,
            host: String::new(),
        };
        let mut session = Self::new(project, String::new(), 0);
        session.sharing = Sharing::new(Controller::Desktop);
        session.ready = true;
        session
    }

    pub(super) fn push(&mut self, chunk: OutputChunk) {
        let raw = match &chunk {
            OutputChunk::Bytes(data) => base64::engine::general_purpose::STANDARD.decode(data).ok(),
            OutputChunk::Screen { .. } => None,
        };
        self.push_decoded(chunk, raw.as_deref());
    }

    /// `raw` 是 `Bytes` 块解码后的字节；调用方已有原始字节时直接传入，省去一次解码。
    pub(super) fn push_decoded(&mut self, chunk: OutputChunk, raw: Option<&[u8]>) {
        self.touch();
        let mut previous_title = self.screen.title().map(str::to_owned);
        match &chunk {
            OutputChunk::Bytes(_) => {
                self.note_output_at(self.last_active);
                if let Some(bytes) = raw {
                    for section in bytes.split_inclusive(|byte| matches!(*byte, 0x07 | 0x1b)) {
                        self.screen.process(section);
                        self.observe_program_title(&mut previous_title);
                    }
                    self.queue_view_bytes(bytes);
                }
            }
            OutputChunk::Screen { data, cols, rows } => {
                self.screen.replace(data, *cols, *rows);
                self.screen.forget_program_status(is_spinner_glyph);
                if let Some(view) = self.view.as_mut() {
                    view.bytes = Vec::new();
                    view.snapshot = true;
                }
            }
        }
        self.observe_program_title(&mut previous_title);
        if matches!(chunk, OutputChunk::Screen { .. }) {
            self.output.clear();
            self.output_size = 0;
        }
        self.output_size += chunk.len();
        self.output.push_back(chunk);
        self.next += 1;
        while self.output_size > MAX_OUTPUT {
            if let Some(removed) = self.output.pop_front() {
                self.output_size -= removed.len();
            }
        }
        self.changed.notify_waiters();
    }

    pub(super) fn queue_view_bytes(&mut self, bytes: &[u8]) {
        let Some(view) = self.view.as_mut() else {
            return;
        };
        if view.snapshot {
            return;
        }
        view.bytes.extend_from_slice(bytes);
        if view.bytes.len() > MAX_VIEW_BACKLOG {
            view.bytes = Vec::new();
            view.snapshot = true;
        }
    }

    /// 共享状态摘要：在线设备与角色、正在输入的一方、尺寸方、锁定、独占和终端尺寸。
    pub(super) fn presence_digest(&self, now: Instant) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        let sharing = &self.sharing;
        let mut devices: Vec<_> = sharing
            .present_devices(now)
            .map(|(id, viewer)| (id.clone(), viewer.observe))
            .collect();
        devices.sort();
        devices.hash(&mut hasher);
        sharing.desktop_present.hash(&mut hasher);
        sharing.typing(now).hash(&mut hasher);
        sharing.size_owner.hash(&mut hasher);
        sharing.size_locked.hash(&mut hasher);
        sharing.exclusive.hash(&mut hasher);
        self.screen.size().hash(&mut hasher);
        hasher.finish()
    }

    /// 共享状态是否和上次通知时不同；不同时记下新摘要并唤醒轮询中的手机。
    pub(super) fn presence_changed(&mut self, now: Instant) -> bool {
        let digest = self.presence_digest(now);
        if std::mem::replace(&mut self.presence_signature, digest) == digest {
            return false;
        }
        self.changed.notify_waiters();
        true
    }

    pub(super) fn observe_program_title(&mut self, previous_title: &mut Option<String>) {
        if previous_title.as_deref() != self.screen.title() {
            self.name_revision += 1;
            if is_spinner_frame(previous_title.as_deref(), self.screen.title()) {
                self.last_spinner_frame = Some(Instant::now());
            }
            *previous_title = self.screen.title().map(str::to_owned);
        }
    }

    pub(super) fn finish(&mut self, exit: Exit) {
        self.exit = Some(exit);
        self.drain_until = Some(Instant::now() + Duration::from_millis(150));
        self.changed.notify_waiters();
    }

    pub(super) fn name(&self) -> String {
        self.custom_name
            .as_deref()
            .or_else(|| self.screen.title())
            .or(self.restored_title.as_deref())
            .or(self.label.as_deref())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("终端 {}", self.number))
    }

    pub(super) fn saved_name(&self) -> SavedSessionName {
        SavedSessionName {
            number: self.number,
            custom_name: self.custom_name.clone(),
            label: self.label.clone(),
            title: self
                .screen
                .title()
                .and_then(stable_title)
                .or_else(|| self.restored_title.clone()),
            created_at_ms: self.created_at_ms,
            detached_since_ms: None,
        }
    }

    pub(super) fn restore_name(&mut self, saved: SavedSessionName) {
        self.number = saved.number;
        self.custom_name = saved.custom_name;
        self.label = saved.label;
        self.restored_title = saved.title;
        self.created_at_ms = saved.created_at_ms;
    }

    pub(super) fn rename(&mut self, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("会话名称最多 80 个字符，不能包含控制字符。".into());
        }
        self.custom_name = if name.is_empty() {
            None
        } else {
            Some(name.into())
        };
        self.name_revision += 1;
        self.changed.notify_waiters();
        Ok(())
    }

    pub(super) fn metadata(&self, id: &str) -> Value {
        json!({ "id": id, "number": self.number, "exit": self.exit,
            "activityRevision": self.activity_revision.fetch_add(1, Ordering::Relaxed),
            "programTitle": self.screen.title(), "programBusy": self.display_busy(),
            "name": self.name(), "customName": self.custom_name, "nameRevision": self.name_revision,
            "lastActiveAt": self.last_active_ms, "createdAt": self.created_at_ms,
            "idleDeadline": self.exit.is_none().then(|| self.last_active_ms + TERMINAL_IDLE.as_millis() as u64),
            "prewarm": self.prewarm_hit })
    }

    /// 后台提醒只需要状态：名称用于通知标题，不返回程序标题之外的终端内容。
    pub(super) fn attention(&self, id: &str) -> Value {
        json!({ "id": id, "name": self.name(), "project": self.project.id,
            "projectName": self.project.name, "busy": self.program_busy(),
            "exited": self.exit.is_some(), "bells": self.screen.attention_count() })
    }

    pub(super) fn read(&self, from: u64) -> Value {
        let base = self.next - self.output.len() as u64;
        let reset = from < base || from > self.next;
        let start = if reset { 0 } else { (from - base) as usize };
        // Bound each HTTP response independently of the retained history.
        let mut budget = 0;
        let chunks: Vec<&OutputChunk> = self
            .output
            .iter()
            .skip(start)
            .take_while(|chunk| {
                let first = budget == 0;
                budget += chunk.encoded_len();
                first || budget <= MAX_POLL_BYTES
            })
            .collect();
        let next = base + (start + chunks.len()) as u64;
        let exit = self
            .exit
            .as_ref()
            .filter(|_| self.drain_until.is_none_or(|until| Instant::now() >= until));
        json!({
            "chunks": chunks,
            "activityRevision": self.activity_revision.fetch_add(1, Ordering::Relaxed),
            "next": next,
            "more": next < self.next,
            "reset": reset,
            "exit": exit,
            "historyBefore": self.screen.history_before(),
            "historyAvailable": self.screen.has_history(),
            "programTitle": self.screen.title(), "programBusy": self.display_busy(),
            "name": self.name(), "customName": self.custom_name, "nameRevision": self.name_revision,
        })
    }

    /// 支持 `tail` 的手机端落后太多时改发最新画面：游标已被淘汰，或积压超过一次轮询的上限。
    /// 全屏程序（如 OpenCode 加载长会话）瞬间重绘大量中间帧，逐帧回放会让手机 WebView 长时间卡死；
    /// 跳过的普通输出仍保留在 `MobileScreen` 历史里，可在只读历史中查看。
    pub(super) fn should_send_latest(&self, from: u64) -> bool {
        let base = self.next - self.output.len() as u64;
        if from < base || from > self.next {
            return true;
        }
        let mut pending = 0;
        for chunk in self.output.iter().skip((from - base) as usize) {
            pending += chunk.encoded_len();
            if pending > MAX_POLL_BYTES {
                return true;
            }
        }
        false
    }

    pub(super) fn latest(&self) -> Value {
        let exit = self
            .exit
            .as_ref()
            .filter(|_| self.drain_until.is_none_or(|until| Instant::now() >= until));
        json!({
            "chunks": [self.screen.snapshot()], "next": self.next,
            "activityRevision": self.activity_revision.fetch_add(1, Ordering::Relaxed),
            "more": false, "reset": false, "snapshot": true, "exit": exit,
            "historyBefore": self.screen.history_before(),
            "historyAvailable": self.screen.has_history(),
            "programTitle": self.screen.title(), "programBusy": self.display_busy(),
            "name": self.name(), "customName": self.custom_name, "nameRevision": self.name_revision,
        })
    }
}

/// `Bytes` carries base64 PTY output. `Screen` carries a daemon screen snapshot as
/// plain terminal text that replaces the visible screen.
#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum OutputChunk {
    Bytes(String),
    Screen { data: String, cols: u16, rows: u16 },
}

impl OutputChunk {
    pub(super) fn len(&self) -> usize {
        match self {
            Self::Bytes(data) | Self::Screen { data, .. } => data.len(),
        }
    }

    /// Escape sequences in snapshots expand to `\u001b` inside JSON.
    pub(super) fn encoded_len(&self) -> usize {
        match self {
            Self::Bytes(data) => data.len(),
            Self::Screen { data, .. } => data.len() * 3,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Exit {
    pub(super) exit_code: u32,
    pub(super) disconnected: bool,
}
