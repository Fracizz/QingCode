//! 识别终端自动应答。
//!
//! 程序查询光标位置、设备属性、颜色等时，每个接入端的终端渲染器都会自动回一条应答。
//! 多端同时接入时这些应答必须只转发一份，否则程序会读到重复或错乱的应答。
//! 这里只看字节形态：整段输入都由应答序列组成才算自动应答，夹带任何按键都按人工输入处理。
//!
//! 已知歧义：`ESC [ 1 ; <2..16> R` 既是光标位置应答，也是带修饰键的 F3。
//! 按应答处理，代价是非尺寸方按 Shift/Ctrl+F3 会被丢弃。

/// 整段输入是否完全由终端自动应答组成。
pub(super) fn is_terminal_reply(data: &str) -> bool {
    let bytes = data.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = 0;
    while index < bytes.len() {
        match reply_len(&bytes[index..]) {
            Some(length) => index += length,
            None => return false,
        }
    }
    true
}

fn reply_len(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 2 || bytes[0] != 0x1b {
        return None;
    }
    match bytes[1] {
        b'[' => csi_reply_len(bytes),
        // 按键不会产生 OSC / DCS / APC，客户端发来的这类串只可能是应答。
        b']' | b'P' | b'_' => string_len(bytes),
        _ => None,
    }
}

/// 以 BEL 或 ST（`ESC \`）结束的控制串；没有结束符不算完整应答。
fn string_len(bytes: &[u8]) -> Option<usize> {
    let mut index = 2;
    while index < bytes.len() {
        match bytes[index] {
            0x07 => return Some(index + 1),
            0x1b => {
                return (bytes.get(index + 1) == Some(&b'\\')).then_some(index + 2);
            }
            _ => index += 1,
        }
    }
    None
}

fn csi_reply_len(bytes: &[u8]) -> Option<usize> {
    let mut index = 2;
    let prefix = match bytes.get(index) {
        Some(byte @ (b'<' | b'=' | b'>' | b'?')) => {
            index += 1;
            Some(*byte)
        }
        _ => None,
    };
    let params_start = index;
    while bytes
        .get(index)
        .is_some_and(|byte| (0x30..=0x3f).contains(byte))
    {
        index += 1;
    }
    let params = &bytes[params_start..index];
    let intermediates_start = index;
    while bytes
        .get(index)
        .is_some_and(|byte| (0x20..=0x2f).contains(byte))
    {
        index += 1;
    }
    let intermediates = &bytes[intermediates_start..index];
    let final_byte = *bytes.get(index)?;
    if !(0x40..=0x7e).contains(&final_byte) {
        return None;
    }
    let length = index + 1;
    let is_reply = match (prefix, intermediates, final_byte) {
        // DA1 / DA2 / DA3 设备属性应答。
        (Some(b'?' | b'>' | b'='), b"", b'c') => true,
        // 光标位置应答（含 DECXCPR）。
        (None | Some(b'?'), b"", b'R') => params.contains(&b';'),
        // 设备状态应答。
        (None, b"", b'n') => matches!(params, b"0" | b"3"),
        (Some(b'?'), b"", b'n') => !params.is_empty(),
        // DECRPM 模式状态应答。
        (None | Some(b'?'), b"$", b'y') => true,
        // kitty 键盘协议的当前标志应答（按键事件没有 `?` 前缀）。
        (Some(b'?'), b"", b'u') => true,
        // 窗口尺寸、位置、状态报告；按键不会以 `t` 结尾。
        (None, b"", b't') => !params.is_empty(),
        // 焦点进入 / 离开报告。
        (None, b"", b'I' | b'O') => params.is_empty(),
        _ => false,
    };
    is_reply.then_some(length)
}

#[cfg(test)]
mod tests {
    use super::is_terminal_reply;

    #[test]
    fn device_and_cursor_reports_are_replies() {
        for reply in [
            "\x1b[?1;2c",
            "\x1b[>0;276;0c",
            "\x1b[=0c",
            "\x1b[24;80R",
            "\x1b[?24;80;1R",
            "\x1b[0n",
            "\x1b[?13n",
            "\x1b[?2004;1$y",
            "\x1b[?1u",
            "\x1b[8;24;80t",
            "\x1b[I",
            "\x1b[O",
        ] {
            assert!(is_terminal_reply(reply), "{reply:?}");
        }
    }

    #[test]
    fn string_reports_need_a_terminator() {
        assert!(is_terminal_reply("\x1b]11;rgb:1e1e/1e1e/1e1e\x07"));
        assert!(is_terminal_reply("\x1b]10;rgb:ffff/ffff/ffff\x1b\\"));
        assert!(is_terminal_reply("\x1bP>|xterm.js(5.5.0)\x1b\\"));
        assert!(is_terminal_reply("\x1bP1$r0m\x1b\\"));
        assert!(is_terminal_reply("\x1b_Gi=1;OK\x1b\\"));
        assert!(!is_terminal_reply("\x1b]11;rgb:1e1e/1e1e/1e1e"));
    }

    #[test]
    fn several_replies_in_one_chunk_are_still_replies() {
        assert!(is_terminal_reply(
            "\x1b[?1;2c\x1b[24;80R\x1b]11;rgb:0/0/0\x07"
        ));
    }

    #[test]
    fn keys_mouse_and_paste_are_user_input() {
        for input in [
            "",
            "a",
            "ls\r",
            "\x1b",
            "\x1b[A",
            "\x1b[1;5C",
            "\x1b[15~",
            "\x1b[97;5u",
            "\x1b[<0;10;5M",
            "\x1b[<0;10;5m",
            "\x1b[200~text\x1b[201~",
            "\x1bOP",
            "\x1b[24;80Rx",
            "x\x1b[24;80R",
            "\x1b[c",
            "\x1b[5n",
        ] {
            assert!(!is_terminal_reply(input), "{input:?}");
        }
    }
}
