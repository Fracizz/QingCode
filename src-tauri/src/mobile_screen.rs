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
/// 自动换行拼回的单个逻辑行上限，避免超长输出变成一行无法分页。
const MAX_JOINED_LINE_BYTES: usize = 16 * 1024;
/// 相邻全屏画面对齐时，允许旧画面末尾若干行被新内容改写（流式输出、计时器等）。
const FRAME_TAIL_TOLERANCE: usize = 3;
pub(super) const TUI_FRAME_MARKER: &str = "── 全屏画面历史 ──";
/// 退出备用屏的控制序列：遇到时强制采样，保留全屏程序退出前的最后画面。
const LEAVE_ALTERNATE: [&[u8]; 3] = [b"\x1b[?1049l", b"\x1b[?1047l", b"\x1b[?47l"];

/// 全屏画面中的一行：`plain` 用于对齐比较，`formatted` 带基本 SGR 颜色，供手机端渲染。
#[derive(Clone, Default)]
struct FrameRow {
    plain: String,
    formatted: String,
}

/// 历史行以「基本格式」保存（文字 + SGR 颜色序列），每行从默认属性开始，可单独渲染。
#[derive(Default)]
struct History {
    lines: VecDeque<(u64, String)>,
    bytes: usize,
    next: u64,
    truncated: bool,
    title: Option<String>,
    tui_sampled_at: Option<Instant>,
    last_tui_frame: String,
    /// 只用于判断上一行是否自动换行（vt100 在下一行开头写 `\n` 表示上一行未换行）。
    wrap_state: BasicFormattedCaptureState,
    /// 最近一次由普通滚动写入的行 id；自动换行的后续行拼接到这一行。
    last_scroll_line: Option<u64>,
    /// 最近采样、尚未提交的全屏画面；滚出画面的部分才写入历史，其余与当前画面重复。
    pending_frame: Vec<FrameRow>,
    /// 当前全屏场景是否已写入分隔标记和固定头部。
    scene_open: bool,
    /// 当前场景已写入的固定头部（纯文本），退出时提交最后画面不再重复。
    scene_header: Vec<String>,
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

fn sgr_color(params: &mut Vec<String>, color: vt100::Color, base: u8, bright: u8, extended: u8) {
    match color {
        vt100::Color::Default => {}
        vt100::Color::Idx(index) if index < 8 => params.push((base + index).to_string()),
        vt100::Color::Idx(index) if index < 16 => params.push((bright + index - 8).to_string()),
        vt100::Color::Idx(index) => params.push(format!("{extended};5;{index}")),
        vt100::Color::Rgb(r, g, b) => params.push(format!("{extended};2;{r};{g};{b}")),
    }
}

/// 按单元格生成全屏画面的行：每行从默认属性开始，只在属性变化时写 SGR。
fn frame_rows(screen: &vt100::Screen) -> Vec<FrameRow> {
    let (rows, cols) = screen.size();
    (0..rows.get())
        .map(|row| {
            let mut result = FrameRow::default();
            let mut current = String::new();
            let mut spaces = 0;
            for col in 0..cols.get() {
                let Some(cell) = screen.cell(row, col) else {
                    continue;
                };
                if cell.is_wide_continuation() {
                    continue;
                }
                let mut params = Vec::new();
                for (enabled, code) in [
                    (cell.bold(), "1"),
                    (cell.dim(), "2"),
                    (cell.italic(), "3"),
                    (cell.underline(), "4"),
                    (cell.inverse(), "7"),
                ] {
                    if enabled {
                        params.push(code.to_string());
                    }
                }
                sgr_color(&mut params, cell.fgcolor(), 30, 90, 38);
                sgr_color(&mut params, cell.bgcolor(), 40, 100, 48);
                let attrs = params.join(";");
                let text = if cell.has_contents() {
                    cell.contents()
                } else {
                    " "
                };
                if text == " " && attrs.is_empty() {
                    spaces += 1;
                    continue;
                }
                if spaces > 0 {
                    if !current.is_empty() {
                        result.formatted.push_str("\x1b[m");
                        current.clear();
                    }
                    let gap = " ".repeat(std::mem::take(&mut spaces));
                    result.plain.push_str(&gap);
                    result.formatted.push_str(&gap);
                }
                if attrs != current {
                    if attrs.is_empty() {
                        result.formatted.push_str("\x1b[m");
                    } else {
                        result.formatted.push_str(&format!("\x1b[0;{attrs}m"));
                    }
                    current = attrs;
                }
                result.plain.push_str(text);
                result.formatted.push_str(text);
            }
            result
        })
        .collect()
}

fn trim_blank_tail(rows: &[FrameRow]) -> &[FrameRow] {
    let end = rows
        .iter()
        .rposition(|row| !row.plain.trim().is_empty())
        .map_or(0, |index| index + 1);
    &rows[..end]
}

/// 新画面的开头与旧画面的哪一行对齐：返回旧画面已滚出的行数。
/// 允许旧画面末尾至多 `FRAME_TAIL_TOLERANCE` 行被改写；找不到时说明画面整体切换。
fn scroll_offset(previous: &[FrameRow], current: &[FrameRow]) -> Option<usize> {
    if previous.is_empty() {
        return Some(0);
    }
    (0..previous.len()).find(|&start| {
        let matched = previous[start..]
            .iter()
            .zip(current)
            .take_while(|(old, new)| old.plain == new.plain)
            .count();
        let reaches_tail = start + matched + FRAME_TAIL_TOLERANCE >= previous.len();
        let meaningful = previous[start..start + matched]
            .iter()
            .any(|row| !row.plain.trim().is_empty());
        matched > 0 && meaningful && reaches_tail
    })
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

    fn open_scene(&mut self, header: &[FrameRow]) {
        if self.scene_open {
            return;
        }
        self.scene_open = true;
        self.push_line(TUI_FRAME_MARKER.to_string());
        let header = trim_blank_tail(header);
        self.scene_header = header.iter().map(|row| row.plain.clone()).collect();
        for row in header {
            self.push_line(row.formatted.clone());
        }
    }

    fn commit_rows(&mut self, header: &[FrameRow], rows: &[FrameRow]) {
        let rows = trim_blank_tail(rows);
        if rows.is_empty() {
            return;
        }
        self.open_scene(header);
        for row in rows {
            self.push_line(row.formatted.clone());
        }
    }

    /// 把采样到的全屏画面并入历史：固定的头部/底部（标题栏、输入框、状态栏）只保留一次，
    /// 内容滚动时只提交滚出画面的行；画面整体切换时提交整屏并开始新场景。
    fn merge_frame(&mut self, current: Vec<FrameRow>) {
        let previous = std::mem::replace(&mut self.pending_frame, current);
        if previous.is_empty() {
            return;
        }
        let current = &self.pending_frame;
        let shared = previous.len().min(current.len());
        let header = previous
            .iter()
            .zip(current)
            .take_while(|(old, new)| old.plain == new.plain)
            .count();
        let footer = previous
            .iter()
            .rev()
            .zip(current.iter().rev())
            .take(shared - header)
            .take_while(|(old, new)| old.plain == new.plain)
            .count();
        let old_body = trim_blank_tail(&previous[header..previous.len() - footer]);
        let new_body = trim_blank_tail(&current[header..current.len() - footer]);
        match scroll_offset(old_body, new_body) {
            Some(scrolled) => {
                let scrolled = old_body[..scrolled].to_vec();
                self.commit_rows(&previous[..header], &scrolled);
            }
            None => {
                let rows = previous[header..previous.len() - footer].to_vec();
                self.commit_rows(&previous[..header], &rows);
                self.scene_open = false;
            }
        }
    }

    /// 离开全屏程序：最后一次采样的画面整体提交，下一次进入全屏时开始新场景。
    fn flush_frame(&mut self) {
        let rows = std::mem::take(&mut self.pending_frame);
        let skip = if self.scene_open
            && rows.len() >= self.scene_header.len()
            && rows
                .iter()
                .zip(&self.scene_header)
                .all(|(row, header)| &row.plain == header)
        {
            self.scene_header.len()
        } else {
            self.scene_open = false;
            0
        };
        self.commit_rows(&[], &rows[skip..]);
        self.scene_open = false;
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

type TuiSample = (Instant, String, Vec<FrameRow>);

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
        let was_alternate = self.parser.screen().alternate_screen();
        let leaving = LEAVE_ALTERNATE.iter().any(|sequence| {
            data.windows(sequence.len())
                .any(|window| window == *sequence)
        });
        let previous = self.take_tui_frame(now, leaving);
        self.parser.process(data);
        self.retain_tui_frame(previous);
        self.flush_after_leaving(was_alternate);
    }

    fn flush_after_leaving(&mut self, was_alternate: bool) {
        if was_alternate && !self.parser.screen().alternate_screen() {
            self.parser.callbacks_mut().flush_frame();
        }
    }

    // TUI applications repaint instead of scrolling normal terminal lines. Sample the
    // screen they are replacing (with basic colors); never replay it into the live terminal.
    fn take_tui_frame(&mut self, now: Instant, force: bool) -> Option<TuiSample> {
        if !self.parser.screen().alternate_screen() {
            return None;
        }
        let history = self.parser.callbacks_mut();
        if !force
            && history
                .tui_sampled_at
                .is_some_and(|last| now.saturating_duration_since(last) < TUI_FRAME_INTERVAL)
        {
            return None;
        }
        let screen = self.parser.screen();
        Some((now, screen.contents(), frame_rows(screen)))
    }

    fn retain_tui_frame(&mut self, previous: Option<TuiSample>) {
        let Some((now, previous, rows)) = previous else {
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
        history.merge_frame(rows);
        history.last_tui_frame = previous;
    }

    pub(super) fn resize(&mut self, cols: u16, rows: u16) {
        self.parser
            .set_size(nonzero(rows.clamp(2, 150)), nonzero(cols.clamp(2, 300)));
    }

    pub(super) fn replace(&mut self, data: &str, cols: u16, rows: u16) {
        let was_alternate = self.parser.screen().alternate_screen();
        let previous = self.take_tui_frame(Instant::now(), true);
        let history = std::mem::take(self.parser.callbacks_mut());
        self.parser = vt100::Parser::new_with_callbacks(
            nonzero(rows.clamp(2, 150)),
            nonzero(cols.clamp(2, 300)),
            0,
            history,
        );
        self.process(data.as_bytes());
        self.retain_tui_frame(previous);
        self.flush_after_leaving(was_alternate);
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

    fn pending_text(screen: &MobileScreen) -> String {
        screen
            .parser
            .callbacks()
            .pending_frame
            .iter()
            .map(|row| row.plain.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn tui_repaints_are_sampled_and_do_not_duplicate_unchanged_screens() {
        let mut screen = MobileScreen::new();
        screen.resize(40, 4);
        let now = Instant::now();
        screen.process_at(b"\x1b[?1049h\x1b[2J\x1b[Hfirst answer", now);
        screen.process_at(b"\x1b[2J\x1b[Hsecond answer", now + Duration::from_secs(1));
        // 最近一次采样先暂存（与当前画面基本重复），尚未写入历史。
        assert_eq!(screen.history_before(), 0);
        assert!(pending_text(&screen).contains("first answer"));
        screen.process_at(
            b"\x1b[2J\x1b[Hthird answer",
            now + Duration::from_millis(1100),
        );
        screen.process_at(b"\x1b[H", now + Duration::from_secs(2));
        assert_eq!(screen.history_before(), 0);
        screen.process_at(b"\x1b[2J\x1b[Hfourth answer", now + Duration::from_secs(3));
        // 画面整体切换：上一张采样提交为一个场景。
        let retained = screen.history(screen.history_before()).to_string();
        assert!(retained.contains("first answer"));
        assert!(!retained.contains("second answer"));
        assert!(!retained.contains("third answer"));
        // 退出全屏程序时提交最后的画面。
        screen.process_at(b"\x1b[?1049lprompt", now + Duration::from_millis(3100));
        let retained = screen.history(screen.history_before()).to_string();
        assert!(retained.contains("third answer"));
        assert!(retained.contains("fourth answer"));
        assert!(!retained.contains("second answer"));
        assert_eq!(retained.matches(TUI_FRAME_MARKER).count(), 3);
    }

    #[test]
    fn cursor_only_or_partial_escape_output_does_not_consume_tui_capture_interval() {
        let mut screen = MobileScreen::new();
        let now = Instant::now();
        screen.process_at(b"\x1b[?1049hfirst answer", now);
        screen.process_at(b"\x1b[H\x1b[", now);
        assert!(pending_text(&screen).is_empty());
        screen.process_at(b"2J\x1b[Hsecond answer", now + Duration::from_millis(10));
        assert!(pending_text(&screen).contains("first answer"));
    }

    #[test]
    fn scrolling_tui_keeps_each_line_once_and_drops_fixed_header_and_footer() {
        let mut screen = MobileScreen::new();
        screen.resize(30, 6);
        let now = Instant::now();
        let frame = |lines: &[&str]| {
            let mut data = String::from("\x1b[2J\x1b[H\x1b[1mHEADER\x1b[m");
            for (index, line) in lines.iter().enumerate() {
                data.push_str(&format!("\x1b[{};1H{line}", index + 2));
            }
            data.push_str("\x1b[5;1H\x1b[32m> Ask anything\x1b[m\x1b[6;1Hstatus bar");
            data
        };
        screen.process_at(
            format!("\x1b[?1049h{}", frame(&["one", "two", "three"])).as_bytes(),
            now,
        );
        for (step, lines) in [
            ["two", "three", "four"],
            ["three", "four", "five"],
            ["five", "six", "seven"],
        ]
        .iter()
        .enumerate()
        {
            screen.process_at(
                frame(lines).as_bytes(),
                now + Duration::from_secs(step as u64 + 1),
            );
        }
        screen.process_at(b"\x1b[?1049l$ ", now + Duration::from_secs(9));
        let page = screen.history(screen.history_before());
        let lines: Vec<&str> = page["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap())
            .collect();
        for word in ["one", "two", "three", "four", "five", "six", "seven"] {
            assert_eq!(
                lines.iter().filter(|line| **line == word).count(),
                1,
                "{word} in {lines:?}"
            );
        }
        assert_eq!(lines.iter().filter(|line| **line == "HEADER").count(), 1);
        assert_eq!(
            lines
                .iter()
                .filter(|line| **line == TUI_FRAME_MARKER)
                .count(),
            1
        );
        // 输入框与状态栏只在退出时的最后画面出现一次。
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.contains("Ask anything"))
                .count(),
            1
        );
        let formatted = screen.history_page(screen.history_before(), true);
        let formatted: Vec<&str> = formatted["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap())
            .collect();
        assert!(formatted.contains(&"\x1b[0;1mHEADER"));
        assert!(formatted.contains(&"\x1b[0;32m> Ask anything"));
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
