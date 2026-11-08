//! Bounded current screen and read-only, cursor-paginated mobile scrollback.
use std::collections::VecDeque;
use std::num::NonZeroU16;

use serde_json::{json, Value};
use vt100::capture::{basic_formatted_to_plain, BasicFormattedCaptureState, RowContents};

const MAX_HISTORY_BYTES: usize = 1024 * 1024;
const MAX_HISTORY_LINES: usize = 5000;
const PAGE_LINES: usize = 120;
const PAGE_BYTES: usize = 64 * 1024;
/// 自动换行拼回的单个逻辑行上限，避免超长输出变成一行无法分页。
const MAX_JOINED_LINE_BYTES: usize = 16 * 1024;
/// 历史行以「基本格式」保存（文字 + SGR 颜色序列），每行从默认属性开始，可单独渲染。
#[derive(Default)]
struct History {
    lines: VecDeque<(u64, String)>,
    bytes: usize,
    next: u64,
    truncated: bool,
    title: Option<String>,
    /// 程序主动发出的提醒次数（BEL、OSC 9 / OSC 777 通知），供手机后台提醒比较增量。
    attention: u64,
    /// 只用于判断上一行是否自动换行（vt100 在下一行开头写 `\n` 表示上一行未换行）。
    wrap_state: BasicFormattedCaptureState,
    /// 最近一次由普通滚动写入的行 id；自动换行的后续行拼接到这一行。
    last_scroll_line: Option<u64>,
}

/// OSC 9（iTerm2 / Windows Terminal 通知，`9;4` 是进度条而不是通知）和 OSC 777;notify。
fn is_notification_osc(params: &[&[u8]]) -> bool {
    match params {
        [b"9", second, ..] => *second != b"4",
        [b"777", b"notify", ..] => true,
        _ => false,
    }
}

impl vt100::Callbacks for History {
    fn audible_bell(&mut self, _: &mut vt100::Screen) {
        self.attention += 1;
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if is_notification_osc(params) {
            self.attention += 1;
        }
    }

    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.update_title(title);
    }

    fn set_window_icon_name(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.update_title(title);
    }

    fn on_scroll(&mut self, row: RowContents<'_>, alternate: bool) {
        if alternate {
            return;
        }
        let mut probe = String::new();
        let _ = row.write_formatted_basic(&mut probe, &mut self.wrap_state);
        let continues_previous = !probe.starts_with('\n');
        let mut formatted = String::new();
        let _ =
            row.write_formatted_basic(&mut formatted, &mut BasicFormattedCaptureState::default());
        // 终端按宽度自动换行的行拼回一个逻辑行，手机按自己的宽度重新排版。
        if continues_previous {
            if let Some((id, line)) = self.lines.back_mut() {
                if Some(*id) == self.last_scroll_line && line.len() < MAX_JOINED_LINE_BYTES {
                    self.bytes += formatted.len();
                    line.push_str(&formatted);
                    self.evict();
                    return;
                }
            }
        }
        self.push_line(formatted);
        self.last_scroll_line = Some(self.next - 1);
    }
}

fn plain(formatted: &str) -> String {
    basic_formatted_to_plain(formatted).collect()
}

impl History {
    fn push_line(&mut self, text: String) {
        self.bytes += text.len();
        self.lines.push_back((self.next, text));
        self.next += 1;
        self.evict();
    }

    fn evict(&mut self) {
        while self.bytes > MAX_HISTORY_BYTES || self.lines.len() > MAX_HISTORY_LINES {
            if let Some((_, removed)) = self.lines.pop_front() {
                self.bytes -= removed.len();
                self.truncated = true;
            }
        }
    }

    fn update_title(&mut self, title: &[u8]) {
        let title: String = String::from_utf8_lossy(title)
            .chars()
            .filter(|character| !character.is_control())
            .take(120)
            .collect();
        let title = title.trim();
        let lower = title.to_lowercase().replace('\\', "/");
        let lower = lower.trim_start_matches("administrator: ");
        let file = lower
            .rsplit('/')
            .next()
            .unwrap_or(lower)
            .trim_end_matches(".exe");
        if title.is_empty()
            || matches!(
                file,
                "powershell"
                    | "powershell 7"
                    | "pwsh"
                    | "cmd"
                    | "bash"
                    | "wsl"
                    | "sh"
                    | "zsh"
                    | "fish"
                    | "conhost"
                    | "openconsole"
                    | "winpty-agent"
                    | "命令提示符"
            )
            || lower.starts_with("windows powershell")
        {
            return;
        }
        self.title = Some(title.to_string());
    }
}

pub(super) struct MobileScreen {
    parser: vt100::Parser<History>,
}

fn nonzero(value: u16) -> NonZeroU16 {
    NonZeroU16::new(value).unwrap_or(NonZeroU16::MIN)
}

impl MobileScreen {
    pub(super) fn title(&self) -> Option<&str> {
        self.parser.callbacks().title.as_deref()
    }

    pub(super) fn attention_count(&self) -> u64 {
        self.parser.callbacks().attention
    }

    pub(super) fn new() -> Self {
        Self {
            parser: vt100::Parser::new_with_callbacks(
                nonzero(24),
                nonzero(80),
                0,
                History::default(),
            ),
        }
    }

    /// 全屏程序（备用屏）重绘不进入历史：手机端上滑直接交给程序自己滚动。
    pub(super) fn process(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    pub(super) fn resize(&mut self, cols: u16, rows: u16) {
        self.parser
            .set_size(nonzero(rows.clamp(2, 150)), nonzero(cols.clamp(2, 300)));
    }

    pub(super) fn replace(&mut self, data: &str, cols: u16, rows: u16) {
        let history = std::mem::take(self.parser.callbacks_mut());
        self.parser = vt100::Parser::new_with_callbacks(
            nonzero(rows.clamp(2, 150)),
            nonzero(cols.clamp(2, 300)),
            0,
            history,
        );
        self.process(data.as_bytes());
    }

    pub(super) fn size(&self) -> (u16, u16) {
        let (rows, cols) = self.parser.screen().size();
        (cols.get(), rows.get())
    }

    pub(super) fn snapshot(&self) -> Value {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        // Restore the active buffer before contents and input modes, like the daemon.
        // The serializer excludes clipboard OSC side effects.
        let buffer = if screen.alternate_screen() {
            "\x1b[?1049h"
        } else {
            "\x1b[?1049l"
        };
        json!({ "data": format!("{buffer}{}", screen.state_formatted()), "cols": cols.get(), "rows": rows.get() })
    }

    pub(super) fn history_before(&self) -> u64 {
        self.parser.callbacks().next
    }

    pub(super) fn has_history(&self) -> bool {
        !self.parser.callbacks().lines.is_empty()
    }

    /// 电脑端只读预览：最近 `lines` 行纯文本历史与当前画面纯文本。
    /// 全屏程序（备用屏）只看当前画面，历史仍是进入程序前的普通输出。
    pub(super) fn preview(&self, lines: usize) -> Value {
        let history = self.parser.callbacks();
        let skip = history.lines.len().saturating_sub(lines);
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        json!({
            "history": history.lines.iter().skip(skip).map(|(_, text)| plain(text)).collect::<Vec<_>>(),
            "screen": screen.contents(),
            "cols": cols.get(), "rows": rows.get(),
            "alternate": screen.alternate_screen(),
            "truncated": history.truncated || skip > 0,
        })
    }

    /// 纯文本历史，兼容旧版手机端。
    #[cfg(test)]
    pub(super) fn history(&self, before: u64) -> Value {
        self.history_page(before, false)
    }

    /// `formatted` 为 true 时保留基本 SGR 颜色序列（只有颜色与字形，不含其他控制序列）。
    pub(super) fn history_page(&self, before: u64, formatted: bool) -> Value {
        let history = self.parser.callbacks();
        let end = before.min(history.next);
        let mut bytes = 0;
        let mut page = Vec::new();
        for (id, text) in history
            .lines
            .iter()
            .rev()
            .filter(|(id, _)| *id < end)
            .take(PAGE_LINES)
        {
            if !page.is_empty() && bytes + text.len() > PAGE_BYTES {
                break;
            }
            bytes += text.len();
            page.push((*id, text.as_str()));
        }
        page.reverse();
        let cursor = page.first().map_or(end, |(id, _)| *id);
        let more = history.lines.front().is_some_and(|(id, _)| *id < cursor);
        json!({
            "lines": page
                .iter()
                .map(|(_, text)| if formatted { (*text).to_string() } else { plain(text) })
                .collect::<Vec<_>>(),
            "before": cursor, "more": more, "truncated": history.truncated && !more,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_title_handles_split_osc_and_survives_screen_replacement() {
        let mut screen = MobileScreen::new();
        screen.process(b"\x1b]2;Open");
        assert_eq!(screen.title(), None);
        screen.process(b"Code\x1b\\");
        assert_eq!(screen.title(), Some("OpenCode"));
        screen.process(b"\x1b]0;powershell.exe\x07");
        assert_eq!(screen.title(), Some("OpenCode"));
        screen.replace("new screen", 80, 24);
        assert_eq!(screen.title(), Some("OpenCode"));
        screen.process("\x1b]1;修复登录\x07".as_bytes());
        assert_eq!(screen.title(), Some("修复登录"));
        screen.process(format!("\x1b]2;{}\x07", "中".repeat(200)).as_bytes());
        assert_eq!(screen.title().unwrap().chars().count(), 120);
    }

    #[test]
    fn attention_counts_bells_and_notifications_but_not_title_or_progress() {
        let mut screen = MobileScreen::new();
        screen.process(b"]2;Claude");
        screen.process(b"]9;4;1;50");
        assert_eq!(screen.attention_count(), 0);
        screen.process(b"");
        assert_eq!(screen.attention_count(), 1);
        screen.process(b"]9;Needs approval");
        assert_eq!(screen.attention_count(), 2);
        screen.process(b"]777;notify;Codex;Done");
        assert_eq!(screen.attention_count(), 3);
        // Server 模式的屏幕快照替换解析器时不能清零，否则手机会丢掉增量。
        screen.replace("hello", 80, 24);
        assert_eq!(screen.attention_count(), 3);
    }

    #[test]
    fn latest_screen_restores_unicode_cursor_and_terminal_modes() {
        let mut screen = MobileScreen::new();
        screen.resize(40, 4);
        screen.process("旧记录\r\n最新提示\x1b[?2004h\x1b[?1h".as_bytes());
        let snapshot = screen.snapshot();
        let mut restored = vt100::Parser::new(nonzero(4), nonzero(40), 0);
        restored.process(snapshot["data"].as_str().unwrap().as_bytes());
        assert_eq!(
            restored.screen().contents(),
            screen.parser.screen().contents()
        );
        assert_eq!(
            restored.screen().cursor_position(),
            screen.parser.screen().cursor_position()
        );
        assert!(restored.screen().bracketed_paste());
        assert!(restored.screen().application_cursor());
    }

    #[test]
    fn history_is_paginated_with_stable_cursors_while_new_output_arrives() {
        let mut screen = MobileScreen::new();
        screen.resize(40, 4);
        for index in 0..300 {
            screen.process(format!("line {index}\r\n").as_bytes());
        }
        let end = screen.history_before();
        let page = screen.history(end);
        assert_eq!(page["lines"].as_array().unwrap().len(), PAGE_LINES);
        assert_eq!(page["more"], true);
        screen.process(b"live output\r\n");
        let older = screen.history(page["before"].as_u64().unwrap());
        assert_eq!(older["lines"].as_array().unwrap().len(), PAGE_LINES);
        assert_ne!(older["lines"][119], page["lines"][0]);
        assert_eq!(screen.history(end), page);
        assert!(!screen.snapshot()["data"]
            .as_str()
            .unwrap()
            .contains("line 0"));
    }

    #[test]
    fn history_is_bounded_and_handles_evicted_cursors_without_restarting() {
        let mut screen = MobileScreen::new();
        screen.resize(300, 2);
        for _ in 0..MAX_HISTORY_LINES + 10 {
            screen.process(format!("{}\r\n", "中".repeat(140)).as_bytes());
        }
        let history = screen.parser.callbacks();
        assert!(history.bytes <= MAX_HISTORY_BYTES);
        assert!(history.lines.len() <= MAX_HISTORY_LINES);
        let expired = screen.history(1);
        assert_eq!(expired["lines"], json!([]));
        assert_eq!(expired["more"], false);
        assert_eq!(expired["truncated"], true);
    }

    #[test]
    fn full_screen_tui_repaints_stay_out_of_history_and_snapshot_omits_osc() {
        let mut screen = MobileScreen::new();
        screen.resize(40, 3);
        screen.process(
            b"shell
a
b
c
",
        );
        let history = screen.history_before();
        screen.process(
            b"[?1049hTUI
a
b
c
]52;c;secret",
        );
        assert_eq!(screen.history_before(), history);
        let snapshot = screen.snapshot();
        assert!(snapshot["data"].as_str().unwrap().starts_with("[?1049h"));
        assert!(!snapshot["data"].as_str().unwrap().contains("secret"));
        // 退出全屏程序后也不补存全屏画面，历史只有普通终端滚出的行。
        screen.process(b"[2J[Hframe[?1049lprompt");
        assert_eq!(screen.history_before(), history);
        let retained = screen.history(screen.history_before()).to_string();
        assert!(!retained.contains("TUI"));
        assert!(!retained.contains("secret"));
    }

    #[test]
    fn scrollback_keeps_basic_colors_and_rejoins_wrapped_rows() {
        let mut screen = MobileScreen::new();
        screen.resize(10, 2);
        screen.process(b"\x1b[31mred\x1b[m plain\r\n0123456789abcdefghij\r\nnext\r\nlast\r\n");
        let plain = screen.history(screen.history_before());
        let lines = plain["lines"].as_array().unwrap();
        assert_eq!(lines[0], "red plain");
        assert_eq!(lines[1], "0123456789abcdefghij");
        let formatted = screen.history_page(screen.history_before(), true);
        let first = formatted["lines"][0].as_str().unwrap();
        assert!(first.starts_with("\x1b[31mred"));
        assert!(!first.contains("\x1b]"));
    }
}
