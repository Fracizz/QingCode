//! 多端共享同一个终端的规则（参考 herdr-core，详见 docs/terminal-multi-attach.md）：
//! - 所有接入端默认都能输入，输入按终端串行、整条写入；
//! - 任一端可以独占，独占期间其他端只读；选择「只读旁观」的设备不能输入；
//! - 终端尺寸跟随最后一次键盘输入的一方，焦点、滚动、自动应答都不算；可以锁定尺寸；
//! - 自动应答只转发尺寸方的那一份，尺寸方不在线时才放行其他端的应答。

use super::reply::is_terminal_reply;
use super::*;

/// 设备超过这么久没有轮询，视为已离开。
pub(crate) const PRESENCE_TIMEOUT: Duration = Duration::from_secs(10);
/// 最近这么久内有输入，在线状态里显示「正在输入」。
pub(crate) const TYPING_WINDOW: Duration = Duration::from_secs(3);
/// 每个终端保留的输入来源记录条数。
const INPUT_LOG_LIMIT: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Controller {
    Desktop,
    Device(String),
}

/// 一次输入的来源记录：谁、什么时候、多少字节、是否自动应答。不保存内容。
#[derive(Clone, Debug)]
pub(crate) struct InputRecord {
    pub(crate) by: Controller,
    pub(crate) at_ms: u64,
    pub(crate) bytes: usize,
    pub(crate) automatic: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct Viewer {
    pub(crate) seen: Instant,
    pub(crate) observe: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InputDecision {
    /// 写入终端；带尺寸时先把终端改成这个尺寸再写入。
    Forward { resize: Option<(u16, u16)> },
    /// 非尺寸方的自动应答，静默丢弃。
    Drop,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum InputRefusal {
    Exclusive(Controller),
    Observer,
}

#[derive(Debug)]
pub(crate) struct Sharing {
    pub(crate) exclusive: Option<Controller>,
    pub(crate) size_owner: Controller,
    pub(crate) size_locked: bool,
    /// 各端最近一次请求的尺寸；只有尺寸方的请求会真正改终端。
    pub(crate) sizes: HashMap<Controller, (u16, u16)>,
    pub(crate) viewers: HashMap<String, Viewer>,
    /// 电脑是否正在显示这个终端：电脑终端始终为 true，手机终端在电脑打开查看标签时为 true。
    pub(crate) desktop_present: bool,
    pub(crate) last_input: Option<(Controller, Instant, u64)>,
    pub(crate) input_log: VecDeque<InputRecord>,
}

impl Sharing {
    pub(crate) fn new(owner: Controller) -> Self {
        Self {
            desktop_present: owner == Controller::Desktop,
            exclusive: None,
            size_owner: owner,
            size_locked: false,
            sizes: HashMap::new(),
            viewers: HashMap::new(),
            last_input: None,
            input_log: VecDeque::new(),
        }
    }

    pub(crate) fn present(&self, who: &Controller, now: Instant) -> bool {
        match who {
            Controller::Desktop => self.desktop_present,
            Controller::Device(id) => self.viewers.get(id).is_some_and(|viewer| {
                now.saturating_duration_since(viewer.seen) < PRESENCE_TIMEOUT
            }),
        }
    }

    fn observer(&self, who: &Controller) -> bool {
        matches!(who, Controller::Device(id) if self.viewers.get(id).is_some_and(|viewer| viewer.observe))
    }

    pub(crate) fn check_writable(&self, who: &Controller) -> Result<(), InputRefusal> {
        if let Some(holder) = self.exclusive.as_ref().filter(|holder| *holder != who) {
            return Err(InputRefusal::Exclusive(holder.clone()));
        }
        if self.observer(who) {
            return Err(InputRefusal::Observer);
        }
        Ok(())
    }

    /// 处理一次输入：校验独占与只读、过滤非尺寸方的自动应答、键盘输入抢尺寸并记录来源。
    pub(crate) fn input(
        &mut self,
        who: Controller,
        data: &str,
        now: Instant,
        now_ms: u64,
    ) -> Result<InputDecision, InputRefusal> {
        self.check_writable(&who)?;
        let automatic = is_terminal_reply(data);
        if automatic && self.size_owner != who && self.present(&self.size_owner, now) {
            return Ok(InputDecision::Drop);
        }
        self.record(InputRecord {
            by: who.clone(),
            at_ms: now_ms,
            bytes: data.len(),
            automatic,
        });
        if automatic {
            return Ok(InputDecision::Forward { resize: None });
        }
        self.last_input = Some((who.clone(), now, now_ms));
        let resize = self.claim_size(who);
        Ok(InputDecision::Forward { resize })
    }

    fn record(&mut self, record: InputRecord) {
        if self.input_log.len() >= INPUT_LOG_LIMIT {
            self.input_log.pop_front();
        }
        self.input_log.push_back(record);
    }

    /// 键盘输入让这一方成为尺寸方；返回需要应用的新尺寸。
    fn claim_size(&mut self, who: Controller) -> Option<(u16, u16)> {
        if self.size_locked || self.size_owner == who {
            return None;
        }
        let size = self.sizes.get(&who).copied();
        self.size_owner = who;
        size
    }

    /// 记录一端请求的尺寸；这一端是尺寸方时返回需要应用的尺寸。
    pub(crate) fn request_size(
        &mut self,
        who: Controller,
        cols: u16,
        rows: u16,
    ) -> Option<(u16, u16)> {
        let size = (cols, rows);
        let previous = self.sizes.insert(who.clone(), size);
        (self.size_owner == who && previous != Some(size)).then_some(size)
    }

    /// 设备轮询或接入时调用；`observe` 为 None 表示沿用之前的角色。返回在线状态是否变化。
    pub(crate) fn see_device(&mut self, device: &str, observe: Option<bool>, now: Instant) -> bool {
        let was_present = self.present(&Controller::Device(device.to_string()), now);
        let viewer = self.viewers.entry(device.to_string()).or_insert(Viewer {
            seen: now,
            observe: false,
        });
        viewer.seen = now;
        let role_changed = observe
            .is_some_and(|observe| std::mem::replace(&mut viewer.observe, observe) != observe);
        !was_present || role_changed
    }

    /// 尺寸方离开且未锁定时，把尺寸交给仍在的一方：优先电脑，其次最近活跃的可写设备。
    /// 返回 `Some(resize)` 表示尺寸方变了，`resize` 为需要应用的尺寸。
    pub(crate) fn hand_over_size(&mut self, now: Instant) -> Option<Option<(u16, u16)>> {
        if self.size_locked || self.present(&self.size_owner, now) {
            return None;
        }
        let next = if self.desktop_present {
            Some(Controller::Desktop)
        } else {
            self.viewers
                .iter()
                .filter(|(_, viewer)| {
                    !viewer.observe && now.saturating_duration_since(viewer.seen) < PRESENCE_TIMEOUT
                })
                .max_by_key(|(_, viewer)| viewer.seen)
                .map(|(id, _)| Controller::Device(id.clone()))
        }?;
        let resize = self.sizes.get(&next).copied();
        self.size_owner = next;
        Some(resize)
    }

    /// 清理已离开的设备记录，返回在线名单是否变化。
    pub(crate) fn forget_absent(&mut self, now: Instant) -> bool {
        let before = self.viewers.len();
        // 离开很久的记录才删除；刚超时的仍保留角色，回来时不用重新选择只读。
        self.viewers
            .retain(|_, viewer| now.saturating_duration_since(viewer.seen) < PRESENCE_TIMEOUT * 30);
        before != self.viewers.len()
    }

    pub(crate) fn present_devices(&self, now: Instant) -> impl Iterator<Item = (&String, &Viewer)> {
        self.viewers.iter().filter(move |(_, viewer)| {
            now.saturating_duration_since(viewer.seen) < PRESENCE_TIMEOUT
        })
    }

    pub(crate) fn typing(&self, now: Instant) -> Option<&Controller> {
        self.last_input
            .as_ref()
            .filter(|(_, at, _)| now.saturating_duration_since(*at) < TYPING_WINDOW)
            .map(|(who, _, _)| who)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone() -> Controller {
        Controller::Device("phone".into())
    }

    #[test]
    fn everyone_writes_and_the_last_typist_owns_the_size() {
        let now = Instant::now();
        let mut sharing = Sharing::new(Controller::Desktop);
        sharing.request_size(Controller::Desktop, 200, 50);
        sharing.see_device("phone", None, now);
        assert_eq!(sharing.request_size(phone(), 40, 30), None);
        assert_eq!(
            sharing.input(phone(), "ls\r", now, 1),
            Ok(InputDecision::Forward {
                resize: Some((40, 30))
            })
        );
        assert_eq!(sharing.size_owner, phone());
        // 尺寸方再次请求尺寸会直接生效。
        assert_eq!(sharing.request_size(phone(), 45, 30), Some((45, 30)));
        assert_eq!(
            sharing.input(Controller::Desktop, "x", now, 2),
            Ok(InputDecision::Forward {
                resize: Some((200, 50))
            })
        );
        assert_eq!(sharing.input_log.len(), 2);
    }

    #[test]
    fn replies_from_non_owners_are_dropped_while_the_owner_is_present() {
        let now = Instant::now();
        let mut sharing = Sharing::new(Controller::Desktop);
        sharing.see_device("phone", None, now);
        assert_eq!(
            sharing.input(phone(), "\x1b[24;80R", now, 1),
            Ok(InputDecision::Drop)
        );
        // 应答不抢尺寸、不算「正在输入」。
        assert_eq!(
            sharing.input(Controller::Desktop, "\x1b[24;80R", now, 2),
            Ok(InputDecision::Forward { resize: None })
        );
        assert!(sharing.typing(now).is_none());
        // 尺寸方不在时放行其他端的应答，程序不会一直等。
        sharing.desktop_present = false;
        assert_eq!(
            sharing.input(phone(), "\x1b[?1;2c", now, 3),
            Ok(InputDecision::Forward { resize: None })
        );
    }

    #[test]
    fn locked_size_ignores_typing() {
        let now = Instant::now();
        let mut sharing = Sharing::new(Controller::Desktop);
        sharing.request_size(phone(), 40, 30);
        sharing.size_locked = true;
        assert_eq!(
            sharing.input(phone(), "a", now, 1),
            Ok(InputDecision::Forward { resize: None })
        );
        assert_eq!(sharing.size_owner, Controller::Desktop);
    }

    #[test]
    fn exclusive_and_observers_cannot_type() {
        let now = Instant::now();
        let mut sharing = Sharing::new(Controller::Desktop);
        sharing.exclusive = Some(Controller::Desktop);
        assert_eq!(
            sharing.input(phone(), "a", now, 1),
            Err(InputRefusal::Exclusive(Controller::Desktop))
        );
        sharing.exclusive = None;
        sharing.see_device("phone", Some(true), now);
        assert_eq!(
            sharing.input(phone(), "a", now, 1),
            Err(InputRefusal::Observer)
        );
    }

    #[test]
    fn size_returns_to_someone_present_when_the_owner_leaves() {
        let start = Instant::now();
        let mut sharing = Sharing::new(Controller::Device("tablet".into()));
        sharing.request_size(Controller::Device("tablet".into()), 100, 40);
        sharing.see_device("tablet", None, start);
        sharing.see_device("phone", None, start);
        sharing.request_size(phone(), 40, 30);
        assert_eq!(sharing.hand_over_size(start), None);
        let later = start + PRESENCE_TIMEOUT + Duration::from_secs(1);
        sharing.see_device("phone", None, later);
        assert_eq!(sharing.hand_over_size(later), Some(Some((40, 30))));
        assert_eq!(sharing.size_owner, phone());
        // 电脑在场时优先交给电脑。
        sharing.desktop_present = true;
        let much_later = later + PRESENCE_TIMEOUT + Duration::from_secs(1);
        assert_eq!(sharing.hand_over_size(much_later), Some(None));
        assert_eq!(sharing.size_owner, Controller::Desktop);
    }

    #[test]
    fn presence_changes_are_reported_once() {
        let now = Instant::now();
        let mut sharing = Sharing::new(Controller::Desktop);
        assert!(sharing.see_device("phone", None, now));
        assert!(!sharing.see_device("phone", None, now));
        assert!(sharing.see_device("phone", Some(true), now));
        assert!(!sharing.see_device("phone", Some(true), now));
        let later = now + PRESENCE_TIMEOUT;
        assert!(sharing.see_device("phone", None, later));
    }
}
