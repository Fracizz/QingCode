//! Windows 远端命令构造：路径转换、PowerShell/cmd 引号与编码、Git 脚本包装。

use super::*;

/// Windows OpenSSH SFTP paths look like `/D:/code/app`. The server writes the
/// canonicalized root with the Windows verbatim prefix (`\\?\D:\code\app`), so
/// both forms must normalize to the same native drive path.
pub(super) fn windows_native_path(path: &str) -> Option<String> {
    let path = path.trim().trim_matches('"');
    let path = path
        .strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix("//?/"))
        .unwrap_or(path);
    let rest = path.strip_prefix('/').unwrap_or(path);
    let mut chars = rest.chars();
    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next() != Some(':') {
        return None;
    }
    // Reject drive-relative paths such as `D:code`; only `D:`, `D:\...` and
    // `D:/...` identify an absolute Windows location.
    if chars
        .next()
        .is_some_and(|separator| separator != '\\' && separator != '/')
    {
        return None;
    }
    let native = rest.replace('/', "\\");
    if native.ends_with(':') {
        Some(format!("{native}\\"))
    } else {
        Some(native)
    }
}

pub(super) fn powershell_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// 生成远端启动 PowerShell 的命令，脚本走 `-EncodedCommand`。
///
/// `quote` 只用于交互式 PTY。Win32-OpenSSH 把 PTY 命令拼成
/// `bash.exe -c <command>` 的一条命令行，不加引号时 bash 只把 `powershell.exe`
/// 当成脚本。包上双引号后，bash、cmd（`/c` 会去掉首尾引号）和 PowerShell 收到的是同一条命令。
///
/// 非 PTY 的 exec（例如 Git）不一样：OpenSSH 用 argv 调用 `bash -c <command>`，
/// `<command>` 已经是完整脚本。再包一层引号，Git Bash 会把整段当成一个文件名，
/// 报 `Permission denied`。
pub(super) fn windows_encoded_powershell(launcher: &str, script: &str, quote: bool) -> String {
    let utf16 = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let command = format!(
        "{launcher} -EncodedCommand {}",
        encode_terminal_data(&utf16)
    );
    if quote {
        format!("\"{command}\"")
    } else {
        command
    }
}

/// Windows 远端 PowerShell 的 UTF-8 启动设置。
///
/// Windows PowerShell 5.1 的 `Get-Content`（`cat` / `type`）默认按系统 ANSI
/// 代码页解码文件，读 UTF-8 文本时中文会显示成 `ä¸­æ–‡`。控制台读写与文件
/// 读取统一固定为 UTF-8，不再依赖远端系统区域设置。
pub(super) const WINDOWS_POWERSHELL_UTF8_SETUP: &str = "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = [Console]::OutputEncoding } catch { }; $OutputEncoding = [Console]::OutputEncoding; $PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'";

/// cmd.exe 的对应设置：`type` 按控制台代码页解码文件。
pub(super) const WINDOWS_CMD_UTF8_SETUP: &str = "chcp 65001>nul";

/// 启动交互式 PowerShell / pwsh，并在提示符出现前进入项目目录。
///
/// 不能等 PTY 出字后再注入 `Set-Location; Clear-Host`。Windows OpenSSH 的
/// ConPTY 启动时会写出 `[2J[m`，注入的回车会把其中的 `m` 粘到最后一条
/// 命令上（`Clear-Hostm`），清屏失败，切目录命令和错误都留在屏幕上。
pub(super) fn windows_powershell_terminal(
    executable: &str,
    native: &str,
    resolved_shell: &str,
    fallback_from: Option<String>,
) -> ResolvedSshTerminal {
    let script = format!(
        "{WINDOWS_POWERSHELL_UTF8_SETUP}; Set-Location -LiteralPath '{}'",
        powershell_literal(native)
    );
    ResolvedSshTerminal {
        command: windows_encoded_powershell(
            &format!("{executable} -NoLogo -NoExit"),
            &script,
            true,
        ),
        enter_directory: None,
        resolved_shell: resolved_shell.to_string(),
        fallback_from,
    }
}

/// 由 PowerShell 切到项目目录后启动 `cmd /K`。
///
/// 直接发 `cmd.exe /K cd /d "D:\..."` 时，默认 shell 若是 Git Bash，路径里的引号和
/// 反斜杠会被 bash 先解释掉；走编码脚本则与默认 shell 无关。
pub(super) fn windows_cmd_terminal(native: &str) -> ResolvedSshTerminal {
    let script = format!(
        "$ProgressPreference = 'SilentlyContinue'; Set-Location -LiteralPath '{}'; & cmd.exe /K '{}'; exit $LASTEXITCODE",
        powershell_literal(native),
        WINDOWS_CMD_UTF8_SETUP
    );
    ResolvedSshTerminal {
        command: windows_encoded_powershell(
            "powershell.exe -NoLogo -NoProfile -NonInteractive",
            &script,
            true,
        ),
        enter_directory: None,
        resolved_shell: "cmd".to_string(),
        fallback_from: None,
    }
}

/// 按 MSVCRT 规则给 Windows 进程命令行参数加引号。
pub(super) fn windows_quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
        } else {
            quoted.push_str(&"\\".repeat(backslashes));
        }
        quoted.push(ch);
        backslashes = 0;
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

pub(super) const WINDOWS_POWERSHELL_EXEC: &str =
    "powershell.exe -NoLogo -NoProfile -NonInteractive";

/// 纯 ASCII 的引导命令，cmd.exe 或 PowerShell 作为默认 shell 时都能原样执行；
/// 真正的脚本以 Base64(UTF-8) 从 stdin 读入，不受命令行长度和转义影响。
pub(super) fn windows_powershell_stdin_command() -> String {
    // 先关闭进度输出，否则首次加载模块会往 stderr 写 CLIXML 进度记录。
    let bootstrap = "$ProgressPreference = 'SilentlyContinue'; $s = [Console]::In.ReadToEnd(); Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s.Trim())))";
    windows_encoded_powershell(WINDOWS_POWERSHELL_EXEC, bootstrap, false)
}

/// cmd.exe 单条命令行上限是 8191 字符，留出余量。
pub(super) const WINDOWS_INLINE_COMMAND_LIMIT: usize = 8000;

/// 脚本直接放进 `-EncodedCommand`，不读 stdin。
///
/// 默认 shell 是 Git Bash 时，stdin 的 EOF 不一定传到 PowerShell，
/// `ReadToEnd()` 会一直挂着，连接断开后进程也留在远端。命令行放不下时返回 None，
/// 由调用方退回 stdin 方式。
pub(super) fn windows_powershell_inline_command(script: &str) -> Option<String> {
    let command = windows_encoded_powershell(WINDOWS_POWERSHELL_EXEC, script, false);
    (command.len() <= WINDOWS_INLINE_COMMAND_LIMIT).then_some(command)
}

/// 用 Process 直接启动 git 并原样转发 stdout 字节，避免 PowerShell 按行重编码破坏 `-z` 输出。
pub(super) fn windows_git_script(native_root: &str, args: &[String]) -> Result<String, String> {
    if args.iter().any(|arg| arg.contains('\0')) || native_root.contains('\0') {
        return Err("Git 参数包含无效字符".to_string());
    }
    let command_line = std::iter::once("-C".to_string())
        .chain(std::iter::once(native_root.to_string()))
        .chain(args.iter().cloned())
        .map(|arg| windows_quote_arg(&arg))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stderr = [Console]::OpenStandardError()
function Write-RawError([string]$text) {{
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $stderr.Write($bytes, 0, $bytes.Length)
  $stderr.Flush()
}}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'git.exe'
$psi.Arguments = '{}'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardErrorEncoding = [Text.Encoding]::UTF8
try {{
  $process = [Diagnostics.Process]::Start($psi)
}} catch {{
  Write-RawError ('远端未安装 git 或 git 不在 PATH 中：' + $_.Exception.Message)
  exit 127
}}
$process.StandardInput.Close()
$errorTask = $process.StandardError.ReadToEndAsync()
$stdout = [Console]::OpenStandardOutput()
$process.StandardOutput.BaseStream.CopyTo($stdout)
$stdout.Flush()
$process.WaitForExit()
Write-RawError $errorTask.Result
exit $process.ExitCode
"#,
        powershell_literal(&command_line)
    ))
}

/// Windows 远端运行任务的 PowerShell 启动参数（daemon 直接启动时使用）。
pub(super) const WINDOWS_TASK_POWERSHELL_ARGS: [&str; 5] = [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
];

/// 运行任务交给 cmd 的命令行变量名；值由 PowerShell 写入，cmd 展开后再解析，
/// 引号、`&&`、管道等与本地 Windows 的 `cmd /d /s /c <target>` 语义一致。
const WINDOWS_TASK_COMMAND_ENV: &str = "QINGCODE_RUN_TASK_COMMAND";

/// 任务脚本路径：SFTP 风格 `/D:/x`、`D:/x`、`D:\x` 或相对路径，统一成 Windows 原生写法。
fn windows_task_path(target: &str) -> String {
    windows_native_path(target).unwrap_or_else(|| target.replace('/', "\\"))
}

fn windows_task_path_is_absolute(native: &str) -> bool {
    windows_native_path(native).is_some() || native.starts_with("\\\\")
}

/// 生成 Windows 远端一次性运行任务的 PowerShell 脚本。
///
/// - `command`：与本地 Windows 一致，用 `cmd.exe /d /s /c` 执行；
/// - `ps1`：当前 PowerShell 直接调用（外层已 `-ExecutionPolicy Bypass`）；
/// - `bat`：`cmd.exe /d /s /c "<path>"`；
/// - `sh`：与本地 Windows 一致交给 `bash`（如 Git Bash）；
/// - `script`：按扩展名选择上述方式，`.py` / `.js` 交给 python / node，其余按文件关联执行。
pub(super) fn windows_task_script(
    native_cwd: &str,
    shell_kind: &str,
    target: &str,
    env: &HashMap<String, String>,
) -> Result<String, String> {
    if target.trim().is_empty() {
        return Err("运行任务 target 不能为空".to_string());
    }
    if target.contains(['\0', '\r', '\n']) || native_cwd.contains(['\0', '\r', '\n']) {
        return Err("运行任务包含无效字符".to_string());
    }
    let kind = if shell_kind == "script" {
        let lower = target.to_ascii_lowercase();
        let extension = lower
            .rsplit(['/', '\\'])
            .next()
            .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext.to_string()))
            .unwrap_or_default();
        match extension.as_str() {
            "ps1" => "ps1",
            "bat" | "cmd" => "bat",
            "sh" | "bash" => "sh",
            "py" => "py",
            "js" | "mjs" | "cjs" => "node",
            _ => "file",
        }
    } else {
        shell_kind
    };
    let path = || {
        let native = windows_task_path(target.trim());
        if native.contains('"') {
            return Err("运行任务路径不能包含双引号".to_string());
        }
        Ok(native)
    };
    let cmd_line = |line: String| -> String {
        format!(
            "$env:{WINDOWS_TASK_COMMAND_ENV} = '{}'; & cmd.exe /d /s /c '%{WINDOWS_TASK_COMMAND_ENV}%'; exit $LASTEXITCODE",
            powershell_literal(&line)
        )
    };
    let run = match kind {
        "command" => cmd_line(target.to_string()),
        "bat" | "file" => cmd_line(format!("\"{}\"", path()?)),
        "sh" => cmd_line(format!("bash \"{}\"", path()?)),
        "py" => cmd_line(format!("python \"{}\"", path()?)),
        "node" => cmd_line(format!("node \"{}\"", path()?)),
        "ps1" => {
            let native = path()?;
            let invoked = if windows_task_path_is_absolute(&native) || native.starts_with(".\\") {
                native
            } else {
                format!(".\\{native}")
            };
            format!(
                "$global:LASTEXITCODE = 0; & '{}'; if (-not $?) {{ if ($LASTEXITCODE) {{ exit $LASTEXITCODE }}; exit 1 }}; exit $LASTEXITCODE",
                powershell_literal(&invoked)
            )
        }
        other => return Err(format!("Windows SSH 项目不支持的运行任务类型：{other}")),
    };
    let mut keys = env.keys().collect::<Vec<_>>();
    keys.sort();
    let mut script =
        format!("{WINDOWS_POWERSHELL_UTF8_SETUP}; $ProgressPreference = 'SilentlyContinue'; ");
    for key in keys {
        script.push_str(&format!(
            "$env:{key} = '{}'; ",
            powershell_literal(&env[key])
        ));
    }
    script.push_str(&format!(
        "Set-Location -LiteralPath '{}'; {run}",
        powershell_literal(native_cwd)
    ));
    Ok(script)
}

pub(super) const WINDOWS_REMOTE_COMMAND_ERROR: &str =
    "Windows SSH 项目暂不支持远程命令、搜索和格式化";

pub(super) fn reject_windows_remote_command(path: &str) -> Result<(), String> {
    if windows_native_path(path).is_some() {
        Err(WINDOWS_REMOTE_COMMAND_ERROR.to_string())
    } else {
        Ok(())
    }
}
