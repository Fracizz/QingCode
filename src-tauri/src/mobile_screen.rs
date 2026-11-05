//! Bounded current screen and read-only, cursor-paginated mobile scrollback.
use std::collections::VecDeque;
use std::num::NonZeroU16;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use vt100::capture::{basic_formatted_to_plain, BasicFormattedCaptureState, RowContents};

const MAX_HISTORY_BYTES: usize = 1024 * 1024;
const MAX_HISTORY_LINES: usize = 5000;
const PAGE_LINES: usize = 120;
const PAGE_BYTES: usize = 64 * 1024;
const TUI_FRAME_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Default)]
struct History {
    lines: VecDeque<(u64, String)>,
    bytes: usize,
    next: u64,
    truncated: bool,
    title: Option<String>,
    tui_sampled_at: Option<Instant>,
    last_tui_frame: String,
}

impl vt100::Callbacks for History {
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
        let mut formatted = String::new();
        let _ =
            row.write_formatted_basic(&mut formatted, &mut BasicFormattedCaptureState::default());
        let text = basic_formatted_to_plain(&formatted).collect::<String>();
        self.push_line(text);
    }
}

impl History {
    fn push_line(&mut self, text: String) {
        self.bytes += text.len();
        self.lines.push_back((self.next, text));
        self.next += 1;
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

    pub(super) fn process(&mut self, data: &[u8]) {
        self.process_at(data, Instant::now());
    }

    fn process_at(&mut self, data: &[u8], now: Instant) {
        let previous = self.take_tui_frame(now);
        self.parser.process(data);
        self.retain_tui_frame(previous);
    }

    // TUI applications repaint instead of scrolling normal terminal lines. Sample the
    // screen they are replacing, as plain text; never replay it into the live terminal.
    fn take_tui_frame(&mut self, now: Instant) -> Option<(Instant, String)> {
        if !self.parser.screen().alternate_screen() {
            return None;
        }
        let history = self.parser.callbacks_mut();
        if history
            .tui_sampled_at
            .is_some_and(|last| now.saturating_duration_since(last) < TUI_FRAME_INTERVAL)
        {
            return None;
        }
        Some((now, self.parser.screen().contents()))
    }

    fn retain_tui_frame(&mut self, previous: Option<(Instant, String)>) {
        let Some((now, previous)) = previous else {
            return;
        };
        if previous.trim().is_empty() || previous == self.parser.screen().contents() {
            return;
        }
        let history = self.parser.callbacks_mut();
        if previous == history.last_tui_frame {
            return;
        }
        history.tui_sampled_at = Some(now);
        history.push_line("── 全屏画面历史 ──".to_string());
        for line in previous.trim_end().lines() {
            history.push_line(line.to_string());
        }
        history.last_tui_frame = previous;
    }

    pub(super) fn resize(&mut self, cols: u16, rows: u16) {
        self.parser
            .set_size(nonzero(rows.clamp(2, 150)), nonzero(cols.clamp(2, 300)));
    }

    pub(super) fn replace(&mut self, data: &str, cols: u16, rows: u16) {
        let previous = self.take_tui_frame(Instant::now());
        let history = std::mem::take(self.parser.callbacks_mut());
        self.parser = vt100::Parser::new_with_callbacks(
            nonzero(rows.clamp(2, 150)),
            nonzero(cols.clamp(2, 300)),
            0,
            history,
        );
        self.process(data.as_bytes());
        self.retain_tui_frame(previous);
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

    pub(super) fn history(&self, before: u64) -> Value {
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
            "lines": page.iter().map(|(_, text)| *text).collect::<Vec<_>>(),
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
    fn full_screen_tui_retains_plain_screen_history_without_replaying_osc() {
        let mut screen = MobileScreen::new();
        screen.resize(40, 3);
        screen.process(b"shell\r\na\r\nb\r\nc\r\n");
        let history = screen.history_before();
        screen.process(b"\x1b[?1049hTUI\r\na\r\nb\r\nc\r\n\x1b]52;c;secret\x07");
        assert_eq!(screen.history_before(), history);
        let snapshot = screen.snapshot();
        assert!(snapshot["data"]
            .as_str()
            .unwrap()
            .starts_with("\x1b[?1049h"));
        assert!(!snapshot["data"].as_str().unwrap().contains("secret"));
        screen.replace("\x1b[2Jprompt", 40, 3);
        assert!(screen.history_before() > history);
        let retained = screen.history(screen.history_before()).to_string();
        assert!(retained.contains("全屏画面历史"));
        assert!(!retained.contains("secret"));
        assert!(!retained.contains("52;c"));
    }

    #[test]
    fn tui_repaints_are_sampled_and_do_not_duplicate_unchanged_screens() {
        let mut screen = MobileScreen::new();
        screen.resize(40, 4);
        let now = Instant::now();
        screen.process_at(b"\x1b[?1049h\x1b[2J\x1b[Hfirst answer", now);
        screen.process_at(b"\x1b[2J\x1b[Hsecond answer", now + Duration::from_secs(1));
        let first = screen.history_before();
        assert!(first > 0);
        screen.process_at(
            b"\x1b[2J\x1b[Hthird answer",
            now + Duration::from_millis(1100),
        );
        assert_eq!(screen.history_before(), first);
        screen.process_at(b"\x1b[H", now + Duration::from_secs(2));
        assert_eq!(screen.history_before(), first);
        screen.process_at(b"\x1b[2J\x1b[Hfourth answer", now + Duration::from_secs(3));
        let retained = screen.history(screen.history_before()).to_string();
        assert!(retained.contains("first answer"));
        assert!(retained.contains("third answer"));
        assert!(!retained.contains("second answer"));
        assert!(!retained.contains("fourth answer"));
        assert!(screen.snapshot()["data"]
            .as_str()
            .unwrap()
            .contains("fourth answer"));
    }

    #[test]
    fn cursor_only_or_partial_escape_output_does_not_consume_tui_capture_interval() {
        let mut screen = MobileScreen::new();
        let now = Instant::now();
        screen.process_at(b"\x1b[?1049hfirst answer", now);
        screen.process_at(b"\x1b[H\x1b[", now);
        assert!(!screen.has_history());
        screen.process_at(b"2J\x1b[Hsecond answer", now + Duration::from_millis(10));
        assert!(screen.has_history());
        assert!(screen
            .history(screen.history_before())
            .to_string()
            .contains("first answer"));
    }

    #[test]
    fn tui_frame_history_shares_normal_history_bounds() {
        let mut screen = MobileScreen::new();
        screen.resize(40, 3);
        let now = Instant::now();
        screen.process_at(b"\x1b[?1049hfirst", now);
        for index in 1..MAX_HISTORY_LINES + 10 {
            screen.process_at(
                format!("\x1b[2J\x1b[Hanswer {index}").as_bytes(),
                now + Duration::from_secs(index as u64),
            );
        }
        let history = screen.parser.callbacks();
        assert!(history.bytes <= MAX_HISTORY_BYTES);
        assert!(history.lines.len() <= MAX_HISTORY_LINES);
        assert!(history.truncated);
    }
}
