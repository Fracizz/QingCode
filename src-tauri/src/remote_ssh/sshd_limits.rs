//! 远端 sshd 的 `MaxSessions` 解析与读取脚本。
//!
//! 终端连接池需要知道一台远端主机允许的并发会话数，才能真正复用同一条
//! SSH 连接。这里只做两件事：
//!
//! 1. [`parse_sshd_max_sessions`]：把 `sshd_config` 文本解析成上限值（纯函数）；
//! 2. [`SSHD_CONFIG_UNIX_COMMAND`] / [`SSHD_CONFIG_WINDOWS_SCRIPT`]：在远端
//!    展开 `Include` 后输出有效配置文本，交给上面的解析函数。
//!
//! 判断只发生在本地，远端不需要额外的工具链：unix 侧只用 POSIX sh 与 `cat`
//! 级别的内建命令，Windows 侧只用 PowerShell 内建命令；读不到文件就当没有
//! 配置，绝不让脚本以非零码退出。

/// OpenSSH 未显式配置 `MaxSessions` 时的默认值（sshd_config(5)）。
pub(crate) const OPENSSH_DEFAULT_MAX_SESSIONS: usize = 10;

/// 从 `sshd_config` 文本里取出生效的 `MaxSessions`。
///
/// 语义按 sshd 自身的行为实现：关键字大小写不敏感，值可以是 0；sshd 对同一
/// 关键字取**首个出现的值**，且 `Match` 之后的配置属于条件块，不属于全局段，
/// 所以遇到 `Match` 就停止。任何非法值都按「该行无效」跳过，继续找后面的值。
pub(crate) fn parse_sshd_max_sessions(config: &str) -> Option<usize> {
    for raw_line in config.lines() {
        // `str::lines` 会去掉 CRLF 的 `\r`，这里再 trim 一次兼容行首缩进。
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let (keyword, rest) = split_keyword(line);
        if keyword.eq_ignore_ascii_case("match") {
            // 只取全局段：`Match` 之后的内容可能只对部分连接生效。
            return None;
        }
        if !keyword.eq_ignore_ascii_case("maxsessions") {
            continue;
        }

        // 行内注释从 `#` 开始，值本身不会包含 `#`。
        let value = rest.split('#').next().unwrap_or("").trim();
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        if let Ok(parsed) = value.parse::<usize>() {
            return Some(parsed);
        }
    }
    None
}

/// 把一行切成「关键字」和「值部分」。
///
/// 关键字到空白或 `=` 为止；`=` 之后的空白一并吃掉，因此
/// `MaxSessions 20`、`MaxSessions\t20`、`MaxSessions=20`、`MaxSessions = 20`
/// 都能得到同样的结果。值部分保持原样（可能还带行内注释）。
fn split_keyword(line: &str) -> (&str, &str) {
    let end = line
        .find(|ch: char| ch.is_whitespace() || ch == '=')
        .unwrap_or(line.len());
    let keyword = &line[..end];
    let mut rest = line[end..].trim_start();
    if let Some(stripped) = rest.strip_prefix('=') {
        rest = stripped.trim_start();
    }
    (keyword, rest)
}

/// 读取远端 unix 主机有效 sshd 配置的 POSIX sh 命令。
///
/// 主配置为 `/etc/ssh/sshd_config`；遇到 `Include` 时按 sshd 语义在原位置
/// 展开（参数可多个、可含通配符，相对路径相对 `/etc/ssh`，无匹配即跳过）。
/// 文件不存在或不可读时静默跳过，退出码恒为 0，避免把「没有配置」误判成
/// 连接失败。只依赖 POSIX sh 内建命令与 `cat`，不依赖 bash。
pub(crate) const SSHD_CONFIG_UNIX_COMMAND: &str = r#"SSHD_DIR=/etc/ssh
SSHD_MAX_DEPTH=16

sshd_emit() {
	_sshd_path=$1
	_sshd_depth=$2
	case $_sshd_depth in
	'' | *[!0-9]*) return 0 ;;
	esac
	if [ "$_sshd_depth" -ge "$SSHD_MAX_DEPTH" ]; then
		return 0
	fi
	if [ ! -f "$_sshd_path" ] || [ ! -r "$_sshd_path" ]; then
		return 0
	fi
	_sshd_cr=$(printf '\r')
	while IFS= read -r _sshd_line || [ -n "$_sshd_line" ]; do
		_sshd_line=${_sshd_line%"$_sshd_cr"}
		IFS=$(printf ' \t')
		set -- $_sshd_line
		_sshd_keyword=${1-}
		if [ "$#" -gt 0 ]; then
			shift
		fi
		case $_sshd_keyword in
		'#'*) ;;
		[Ii][Nn][Cc][Ll][Uu][Dd][Ee] | [Ii][Nn][Cc][Ll][Uu][Dd][Ee]=*)
			case $_sshd_keyword in
			*=*) set -- "${_sshd_keyword#*=}" "$@" ;;
			esac
			for _sshd_arg in "$@"; do
				sshd_emit "$_sshd_arg" $((_sshd_depth + 1))
			done
			;;
		*) printf '%s\n' "$_sshd_line" ;;
		esac
	done <"$_sshd_path"
	return 0
}

cd "$SSHD_DIR" 2>/dev/null
sshd_emit "/etc/ssh/sshd_config" 0
exit 0
"#;

/// 读取远端 Windows 主机有效 sshd 配置的 PowerShell 脚本。
///
/// 与 unix 版本同语义：主配置 `%ProgramData%\ssh\sshd_config`，`Include`
/// 在原位置展开（相对路径相对 `%ProgramData%\ssh`），读不到的文件静默跳过，
/// 末尾固定 `exit 0`。
pub(crate) const SSHD_CONFIG_WINDOWS_SCRIPT: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
$SshdDir = Join-Path $env:ProgramData 'ssh'
$SshdMaxDepth = 16

function Read-SshdConfig {
	param([string]$Path, [int]$Depth)
	if ($Depth -ge $SshdMaxDepth) { return }
	if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
	$lines = Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue
	if ($null -eq $lines) { return }
	foreach ($line in $lines) {
		if ($null -eq $line) { continue }
		$trimmed = $line.Trim()
		if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) {
			Write-Output $line
			continue
		}
		$parts = $trimmed -split '\s+', 2
		$keyword = $parts[0]
		$rest = ''
		if ($parts.Length -gt 1) { $rest = $parts[1] }
		if ($keyword -ieq 'Include' -or $keyword -imatch '^Include=') {
			if ($keyword -imatch '^Include=(.*)$') { $rest = $Matches[1] }
			foreach ($pattern in ($rest -split '\s+')) {
				if ($pattern.Length -eq 0 -or $pattern.StartsWith('#')) { continue }
				$target = $pattern
				if (-not [System.IO.Path]::IsPathRooted($pattern)) {
					$target = Join-Path $SshdDir $pattern
				}
				foreach ($item in (Resolve-Path -Path $target -ErrorAction SilentlyContinue)) {
					Read-SshdConfig -Path $item.Path -Depth ($Depth + 1)
				}
			}
			continue
		}
		Write-Output $line
	}
}

Read-SshdConfig -Path (Join-Path $SshdDir 'sshd_config') -Depth 0
exit 0
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_max_sessions_reads_plain_value() {
        assert_eq!(parse_sshd_max_sessions("MaxSessions 20\n"), Some(20));
    }

    #[test]
    fn parse_max_sessions_empty_input_is_none() {
        assert_eq!(parse_sshd_max_sessions(""), None);
    }

    #[test]
    fn parse_max_sessions_handles_crlf_and_tabs() {
        assert_eq!(
            parse_sshd_max_sessions("Port 22\r\nMaxSessions\t32\r\nX11Forwarding yes\r\n"),
            Some(32)
        );
    }

    #[test]
    fn parse_max_sessions_handles_equals_and_spaces() {
        assert_eq!(parse_sshd_max_sessions("maxsessions=12\n"), Some(12));
        assert_eq!(parse_sshd_max_sessions("MaxSessions = 13\n"), Some(13));
    }

    #[test]
    fn parse_max_sessions_ignores_inline_comment() {
        assert_eq!(parse_sshd_max_sessions("MaxSessions 7 # 注释\n"), Some(7));
    }

    #[test]
    fn parse_max_sessions_keeps_first_value() {
        let config = "MaxSessions 4\nMaxSessions 99\n";
        assert_eq!(parse_sshd_max_sessions(config), Some(4));
    }

    #[test]
    fn parse_max_sessions_ignores_match_blocks() {
        let config = "Port 22\nMatch User git\n\tMaxSessions 50\n";
        assert_eq!(parse_sshd_max_sessions(config), None);
    }

    #[test]
    fn parse_max_sessions_skips_invalid_values() {
        let config = "MaxSessions abc\nMaxSessions -1\nMaxSessions\nMaxSessions 15\n";
        assert_eq!(parse_sshd_max_sessions(config), Some(15));
    }

    #[test]
    fn parse_max_sessions_accepts_zero() {
        assert_eq!(parse_sshd_max_sessions("MaxSessions 0\n"), Some(0));
    }

    #[test]
    fn parse_max_sessions_ignores_commented_out_line() {
        assert_eq!(
            parse_sshd_max_sessions("#MaxSessions 99\nMaxSessions 6\n"),
            Some(6)
        );
    }

    #[test]
    fn parse_max_sessions_value_without_separator_is_invalid() {
        assert_eq!(parse_sshd_max_sessions("MaxSessions20\n"), None);
    }

    #[test]
    fn sshd_scripts_are_available() {
        assert!(!SSHD_CONFIG_UNIX_COMMAND.is_empty());
        assert!(!SSHD_CONFIG_WINDOWS_SCRIPT.is_empty());
        assert!(SSHD_CONFIG_UNIX_COMMAND.contains("/etc/ssh/sshd_config"));
        assert!(SSHD_CONFIG_WINDOWS_SCRIPT.contains("ProgramData"));
        assert!(SSHD_CONFIG_WINDOWS_SCRIPT.contains("exit 0"));
    }
}
