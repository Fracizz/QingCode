//! 远端脚本与命令的构造（unix shell / Windows PowerShell，纯函数），
//! 以及远端 sha256 输出的解析与本地摘要计算。

use super::paths::windows_host_path;
use super::*;

/// 项目 serve 日志（`.qingcode/server/serve.log`）的截断阈值：启动前超过
/// 1MB 就先删掉重建，日志才是有界的，长期开着的仓库不会把它堆成巨文件。
pub(crate) const SERVE_LOG_TRUNCATE_BYTES: u64 = 1024 * 1024;

/// Windows 部署脚本：只负责日志截断 + 以简单参数调用 `serve --detach`。
///
/// 为什么不再用 PowerShell P/Invoke CreateProcess（真机实测三连坑）：
/// - PowerShell 调 .NET P/Invoke 时会把 `$null` 强转成 `""`，CreateProcess 拿
///   `""` 当可执行文件解析，恒报 ERROR_PATH_NOT_FOUND；
/// - `cmd /c ""exe" args >> log 2>&1"` 的双层引号会把重定向归属搞乱（外层 cmd
///   吃掉重定向，日志文件被创建但永远是空的）；
/// - 从 SSH 会话以 bInheritHandles=TRUE 拉起长命子进程，会把会话的 stdout 管道
///   泄漏给它，exec 通道被挂住不结束。
///
/// 现在 server 原生自脱离（Zed remote_server 同款）：`--detach` 由 serve 自己再
/// 拉起一个脱离副本（`CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB` 由 serve
/// 设置，stdout/stderr 接到 `--log-file`），客户端只传简单 argv，脚本里没有任何
/// 引号拼接。
pub(crate) fn windows_deploy_server_script(
    bin: &str,
    root: &str,
    state: &str,
    log: &str,
) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$bin = '{bin}'
$root = '{root}'
$state = '{state}'
$log = '{log}'
if (-not (Test-Path -LiteralPath $bin)) {{ throw 'server binary missing' }}
if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt {limit})) {{
  Remove-Item -LiteralPath $log -Force
}}
& $bin serve --root $root --state $state --detach --log-file $log
"#,
        bin = powershell_literal(bin),
        root = powershell_literal(root),
        state = powershell_literal(state),
        log = powershell_literal(log),
        limit = SERVE_LOG_TRUNCATE_BYTES,
    )
}

pub(crate) fn windows_remove_file_script(path: &str) -> String {
    format!(
        "Remove-Item -LiteralPath '{}' -Force -ErrorAction SilentlyContinue",
        powershell_literal(path)
    )
}

/// 先核对进程名和命令行里的状态文件路径，再结束 serve。对不上就不杀。
pub(crate) fn windows_kill_server_script(pid: u32, state_path: &str) -> String {
    format!(
        r"$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' -ErrorAction SilentlyContinue
if ($p -and $p.Name -like 'qingcode-server*' -and $p.CommandLine -and $p.CommandLine.Contains('{state}')) {{
  Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue
}}",
        pid = pid,
        state = powershell_literal(state_path),
    )
}

/// Windows：结束所有以 `bin` 为可执行文件的进程（替换二进制前释放文件锁）。
///
/// Windows 不允许覆盖或删除正在运行的 exe。同一个二进制可能同时以 serve、
/// daemon、connect 代理三种身份在跑，升级时必须让它们全部退出。只按
/// `ExecutablePath` 精确（大小写不敏感）匹配，其他路径的进程一律不动。
pub(crate) fn windows_stop_processes_script(bin: &str) -> String {
    format!(
        r"$target = '{bin}'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {{ $_.ExecutablePath -and ($_.ExecutablePath -ieq $target) }} |
  ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}",
        bin = powershell_literal(bin),
    )
}

pub(super) fn windows_stop_for(remote_bin: &str) -> String {
    windows_host_path(remote_bin)
        .map(|path| windows_stop_processes_script(&path))
        .unwrap_or_default()
}

pub(super) fn windows_deploy_for(
    remote_bin: &str,
    remote_root: &str,
    remote_state: &str,
    remote_log: &str,
) -> Result<String, String> {
    if windows_native_path(remote_root).is_none() {
        return Ok(String::new());
    }
    let bin = windows_host_path(remote_bin).ok_or("Windows server 路径无效")?;
    let root = windows_host_path(remote_root).ok_or("Windows 项目路径无效")?;
    let state = windows_host_path(remote_state).ok_or("Windows server 状态路径无效")?;
    let log = windows_host_path(remote_log).ok_or("Windows server 日志路径无效")?;
    Ok(windows_deploy_server_script(&bin, &root, &state, &log))
}

pub(super) fn windows_remove_for(remote_bin: &str) -> String {
    windows_host_path(remote_bin)
        .map(|path| windows_remove_file_script(&path))
        .unwrap_or_default()
}

pub(super) fn windows_kill_for(state_path: &str, pid: u32) -> String {
    windows_host_path(state_path)
        .map(|path| windows_kill_server_script(pid, &path))
        .unwrap_or_default()
}

/// 生成远端启动命令：`nohup setsid` 让 server 脱离本次 SSH 会话存活。
/// 输出追加重定向进项目 serve 日志（不再丢 /dev/null），否则启动失败
/// （端口占用、rc=3、动态库缺失）没有任何痕迹可查；启动前先看日志体积，
/// 超过 [`SERVE_LOG_TRUNCATE_BYTES`] 就删掉重建，日志才有界。参数逐个
/// shell_quote 防注入；token 由 server 启动时自生成并写进状态文件，
/// 无需在命令行传递。
pub(crate) fn deploy_server_command(bin: &str, root: &str, state: &str, log: &str) -> String {
    format!(
        "log={log_arg}; size=$(wc -c < \"$log\" 2>/dev/null || echo 0); \
         [ \"${{size:-0}}\" -gt {limit} ] && rm -f -- \"$log\"; \
         nohup setsid {bin_arg} serve --root {root_arg} --state {state_arg} >>\"$log\" 2>&1 &",
        log_arg = shell_quote(log),
        limit = SERVE_LOG_TRUNCATE_BYTES,
        bin_arg = shell_quote(bin),
        root_arg = shell_quote(root),
        state_arg = shell_quote(state)
    )
}

/// 幂等启动远端 daemon：`nohup setsid` 脱离本次 SSH 会话，输出丢弃；
/// 已有实例时新进程因抢不到 `flock` 直接退出 0，重复执行无副作用。
pub(crate) fn start_daemon_command(bin: &str) -> String {
    format!("nohup setsid {} daemon >/dev/null 2>&1 &", shell_quote(bin))
}

/// 连接代理命令：在 exec 通道内运行，随通道生灭。`--ensure-daemon` 让代理
/// 在 daemon 缺席时自行拉起（`flock` 保证单实例）。
pub(crate) fn connect_daemon_command(bin: &str) -> String {
    format!("{} connect --stdio --ensure-daemon", shell_quote(bin))
}

/// 只连已有 daemon 的代理命令：缺席时立刻失败，**不会**顺手拉起新实例。
/// 升级淘汰旧 daemon 时用它，避免在替换二进制前反而先启动一个旧版 daemon。
pub(crate) fn connect_daemon_command_existing(bin: &str) -> String {
    format!("{} connect --stdio", shell_quote(bin))
}

/// 读取 daemon 会话 token 的命令。token 由 daemon 启动时写入
/// `$HOME/.qingcode/server/run/token`（权限 `0600`），仅同一 SSH 用户可读。
pub(crate) fn daemon_token_command() -> String {
    "cat \"$HOME/.qingcode/server/run/token\" 2>/dev/null".to_string()
}

/// Windows：daemon 幂等启动脚本（经 exec_remote_shell 的 PowerShell 包装）。
/// `daemon --detach` 由 server 自身再拉起脱离副本（`CREATE_NO_WINDOW |
/// CREATE_BREAKAWAY_FROM_JOB`，与 serve `--detach` 同机制），启动器立即退出；
/// 已有实例时新 daemon 抢不到首实例锁，按成功退出，重复执行无副作用。
pub(crate) fn windows_daemon_start_script(native_bin: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'
& '{bin}' daemon --detach
if ($LASTEXITCODE -ne 0) {{ exit 1 }}",
        bin = powershell_literal(native_bin),
    )
}

/// Windows：读取 daemon 会话 token 的脚本。token 路径由 daemon 侧
/// `%USERPROFILE%\.qingcode\server\run\token` 决定，这里用同一环境变量拼出。
pub(crate) fn windows_daemon_token_script() -> String {
    "$token = Join-Path $env:USERPROFILE '.qingcode\\server\\run\\token'
Get-Content -LiteralPath $token -ErrorAction SilentlyContinue"
        .to_string()
}

/// Windows：connect 代理的 exec 命令——**不经过 PowerShell 包装**，直接 exec
/// 二进制本体。PS 的启动噪声（`#< CLIXML`、模块加载进度流）会混进 stdout
/// 破坏二进制帧流；远端默认 shell（cmd / Git Bash）对原生进程是句柄直通，
/// 帧流原样可达。反斜杠转正斜格并去 POSIX 前导斜杠：`/D:/x/y.exe` →
/// `D:/x/y.exe`，bash 与 cmd 都能直接执行。
pub(crate) fn windows_connect_daemon_command(remote_bin: &str) -> String {
    let trimmed = remote_bin.trim_start_matches('/');
    let forward = trimmed.replace('\\', "/");
    format!("\"{forward}\" connect --stdio --ensure-daemon")
}

/// 只连已有 daemon 的 Windows 代理命令（不会拉起新实例），用于升级前淘汰旧实例。
pub(crate) fn windows_connect_daemon_command_existing(remote_bin: &str) -> String {
    let trimmed = remote_bin.trim_start_matches('/');
    let forward = trimmed.replace('\\', "/");
    format!("\"{forward}\" connect --stdio")
}

/// 生成清理旧 server 的命令：先校验 `/proc/<pid>/cmdline` 的进程身份再 kill。
///
/// 状态文件可能是上一轮部署的残留（pid 已被系统复用）或别的项目根遗留，
/// 直接按状态文件里的 pid `kill` 会误杀远端无关进程。因此要求同一进程的
/// 命令行里既出现二进制名 `qingcode-server`，`--state` 参数又正好等于本项目的
/// 状态文件路径；任一条件不满足就不产生任何副作用。整条命令以 `|| true`
/// 收尾，属于尽力而为的清理，失败不影响后续部署。
pub(crate) fn kill_server_command(pid: u32, state_path: &str) -> String {
    // /proc/<pid>/cmdline 以 NUL 分隔参数，先转成换行再按行匹配：
    // `grep -qxF` 用整行精确比对，避免路径前缀相同（如 a 与 a2）误判。
    format!(
        "test -r /proc/{pid}/cmdline \
         && tr '\\000' '\\n' < /proc/{pid}/cmdline | grep -q -- qingcode-server \
         && tr '\\000' '\\n' < /proc/{pid}/cmdline | grep -qxF -- {} \
         && kill {pid} 2>/dev/null || true",
        shell_quote(state_path)
    )
}

/// 清理旧版（改名 server 之前）遗留的 agent serve：身份校验与
/// [`kill_server_command`] 同构，但 cmdline 里匹配的是旧二进制名
/// `qingcode-agent`。身份对上才 kill，并**只删旧状态文件本身**——不动整个
/// `.qingcode/agent/` 目录，那里可能有用户自己的文件。
pub(crate) fn legacy_agent_cleanup_command(pid: u32, state_path: &str) -> String {
    format!(
        "if test -r /proc/{pid}/cmdline \
         && tr '\\000' '\\n' < /proc/{pid}/cmdline | grep -q -- qingcode-agent \
         && tr '\\000' '\\n' < /proc/{pid}/cmdline | grep -qxF -- {}; then \
         kill {pid} 2>/dev/null; rm -f -- {}; fi",
        shell_quote(state_path),
        shell_quote(state_path)
    )
}

/// Windows 版旧版 agent 清理：进程名/命令行校验后再 Stop-Process，
/// 成功路径里顺带删除旧状态文件（不删旧目录）。
pub(crate) fn windows_legacy_agent_cleanup_script(pid: u32, state_path: &str) -> String {
    format!(
        r"$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' -ErrorAction SilentlyContinue
$state = '{state}'
if ($p -and $p.Name -like 'qingcode-agent*' -and $p.CommandLine -and $p.CommandLine.Contains($state)) {{
  Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $state -Force -ErrorAction SilentlyContinue
}}",
        pid = pid,
        state = powershell_literal(state_path),
    )
}

/// 远端 self-check 命令（unix）：上传后立刻 exec 校验，确认落盘二进制与
/// 本地逐字节一致，顺带探测部署目录是否挂了 noexec（exec 失败即暴露）。
pub(crate) fn self_check_command(bin: &str, expected_sha256: &str) -> String {
    format!(
        "{} self-check --expect-sha256 {}",
        shell_quote(bin),
        shell_quote(expected_sha256)
    )
}

/// 远端 self-check 脚本（Windows）：`$LASTEXITCODE` 需要显式转成脚本退出码，
/// 否则 PowerShell 自身退出 0 会把校验失败吞掉。
pub(crate) fn windows_self_check_script(bin: &str, expected_sha256: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'
& '{bin}' self-check --expect-sha256 '{sha}'
if ($LASTEXITCODE -ne 0) {{ exit 1 }}",
        bin = powershell_literal(bin),
        sha = powershell_literal(expected_sha256),
    )
}

/// 计算远端已部署二进制 sha256 的命令（unix）。`cut -c1-64` 取
/// `sha256sum` 输出行首的摘要段，不受文件名里的空格影响。
pub(super) fn remote_sha256_command(remote_bin: &str) -> String {
    format!(
        "sha256sum -- {} 2>/dev/null | cut -c1-64",
        shell_quote(remote_bin)
    )
}

/// 计算远端已部署二进制 sha256 的脚本（Windows）。
pub(super) fn windows_remote_sha256_script(remote_bin: &str) -> String {
    format!(
        "(Get-FileHash -LiteralPath '{}' -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash.ToLower()",
        powershell_literal(remote_bin)
    )
}

/// 解析远端 sha256 命令输出：取第一个空白分隔 token，必须是 64 位十六进制。
/// 输出为空（文件不存在 / 工具缺失）或垃圾一律返回 None，调用方回退为重新上传。
fn parse_remote_sha256(stdout: &str) -> Option<String> {
    let token = stdout.split_whitespace().next()?;
    if token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Some(token.to_ascii_lowercase())
    } else {
        None
    }
}

/// 远端 sha256 输出是否与本地摘要一致（大小写归一后比较）。
pub(super) fn remote_sha256_matches(stdout: &str, expected: &str) -> bool {
    parse_remote_sha256(stdout).is_some_and(|actual| actual == expected.trim().to_ascii_lowercase())
}

/// 本地文件的 sha256 小写十六进制摘要。
pub(super) fn sha256_of_file(path: &Path) -> Result<String, String> {
    use sha2::Digest;
    let bytes =
        std::fs::read(path).map_err(|error| format!("读取本地 server 二进制失败：{error}"))?;
    Ok(sha2::Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// 本地二进制摘要缓存：路径 → (大小, 修改时间, sha256)。文件被替换（大小或
/// 修改时间变化）时自动失效。
type Sha256Cache = Mutex<HashMap<PathBuf, (u64, std::time::SystemTime, String)>>;

fn sha256_cache() -> &'static Sha256Cache {
    static CACHE: std::sync::OnceLock<Sha256Cache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 本地文件的元数据指纹；任何一项取不到都视为不可缓存。
fn file_fingerprint(path: &Path) -> Option<(u64, std::time::SystemTime)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

/// 同 [`sha256_of_file`]，但在阻塞线程池里读文件（几十 MB 的二进制不占 async
/// 运行时线程），并按大小 + 修改时间缓存结果：每次发现/部署都要比对摘要，
/// 不必反复整文件读取哈希。
pub(super) async fn sha256_of_file_cached(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let fingerprint = file_fingerprint(&path);
        if let Some((len, modified)) = fingerprint {
            if let Some((cached_len, cached_modified, sha)) = sha256_cache()
                .lock()
                .ok()
                .and_then(|cache| cache.get(&path).cloned())
            {
                if cached_len == len && cached_modified == modified {
                    return Ok(sha);
                }
            }
        }
        let sha = sha256_of_file(&path)?;
        // 哈希前后的指纹一致才写缓存，避免把读到一半被替换的文件摘要记下来。
        if let Some((len, modified)) = fingerprint.filter(|fp| file_fingerprint(&path) == Some(*fp))
        {
            if let Ok(mut cache) = sha256_cache().lock() {
                cache.insert(path, (len, modified, sha.clone()));
            }
        }
        Ok(sha)
    })
    .await
    .map_err(|error| format!("计算本地 server 摘要任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::super::paths::{server_binary_file_name, server_binary_remote_path};
    use super::*;

    #[tokio::test]
    async fn cached_sha256_matches_direct_and_refreshes_after_file_change() {
        let dir = std::env::temp_dir().join(format!("qc-sha-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("qingcode-server-x86_64");
        std::fs::write(&file, b"first").unwrap();
        let first = sha256_of_file_cached(&file).await.unwrap();
        assert_eq!(first, sha256_of_file(&file).unwrap());
        // 命中缓存仍返回同一摘要。
        assert_eq!(sha256_of_file_cached(&file).await.unwrap(), first);
        // 大小变化让缓存失效（不依赖文件系统时间精度）。
        std::fs::write(&file, b"second build").unwrap();
        let second = sha256_of_file_cached(&file).await.unwrap();
        assert_ne!(second, first);
        assert_eq!(second, sha256_of_file(&file).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_binary_name_and_deploy_script_use_native_paths() {
        assert_eq!(
            server_binary_file_name(true, "x86_64"),
            "qingcode-server-windows-x86_64.exe"
        );
        assert_eq!(
            server_binary_remote_path("/D:/code/app", true, "aarch64"),
            "/D:/code/app/.qingcode/server/qingcode-server-windows-aarch64.exe"
        );
        let script = windows_deploy_for(
            "/D:/code/app/.qingcode/server/qingcode-server-windows-x86_64.exe",
            "/D:/code/app",
            "/D:/code/app/.qingcode/server/server.json",
            "/D:/code/app/.qingcode/server/serve.log",
        )
        .unwrap();
        assert!(script.contains(r"D:\code\app\.qingcode\server\qingcode-server-windows-x86_64.exe"));
        // 脱离会话由 serve --detach 原生完成，客户端脚本只传简单 argv。
        assert!(script.contains("--detach"));
        assert!(script.contains("--log-file"));
        assert!(script.contains(r"D:\code\app\.qingcode\server\server.json"));
        // serve 输出重定向进项目日志，不再静默丢弃。
        assert!(script.contains(r"D:\code\app\.qingcode\server\serve.log"));
        // 启动前按体积截断日志，超过 1MB 删掉重建，日志才有界。
        assert!(script.contains(&format!("-gt {SERVE_LOG_TRUNCATE_BYTES}")));
        // 旧的 P/Invoke / cmd /c / Start-Process 路径必须全部移除：
        // 引号拼接与句柄继承是旧路径的三大问题根源，改由 serve 自脱离。
        assert!(!script.contains("Add-Type"));
        assert!(!script.contains("CreateProcess"));
        assert!(!script.contains("cmd /c"));
        assert!(!script.contains("Start-Process"));
        assert!(windows_deploy_for(
            "/srv/app/qingcode-server-x86_64",
            "/srv/app",
            "/srv/app/server.json",
            "/srv/app/serve.log"
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn deploy_command_quotes_all_arguments_and_redirects_to_log() {
        let log = "/srv/app/.qingcode/server/serve.log";
        let command = deploy_server_command(
            "/srv/app/.qingcode/server/qingcode-server-x86_64",
            "/srv/app",
            "/srv/app/.qingcode/server/server.json",
            log,
        );
        // 启动前先按体积截断日志，超过 1MB 删掉重建，日志才有界。
        assert!(command.contains(&format!("log='{}'", log)));
        assert!(command.contains(&format!("-gt {SERVE_LOG_TRUNCATE_BYTES}")));
        assert!(command.contains("rm -f -- \"$log\""));
        assert!(command.contains("serve --root '/srv/app'"));
        assert!(command.contains("--state '/srv/app/.qingcode/server/server.json'"));
        // 输出追加重定向进 serve 日志，不再丢 /dev/null。
        assert!(command.ends_with(">>\"$log\" 2>&1 &"));
        // 命令行不携带 token：server 自生成并写进状态文件，避免凭据留在进程列表里。
        assert!(!command.contains("--token"));
    }

    #[test]
    fn kill_command_verifies_process_identity_before_killing() {
        let command = kill_server_command(1234, "/srv/app/.qingcode/server/server.json");
        // 必须先读 /proc/<pid>/cmdline 并确认二进制名，不能无条件 kill。
        assert!(command.contains("/proc/1234/cmdline"));
        assert!(command.contains("grep -q -- qingcode-server"));
        // 状态文件路径整行精确匹配，避免误杀别的项目根的 server。
        assert!(command.contains("grep -qxF -- '/srv/app/.qingcode/server/server.json'"));
        assert!(command.contains("kill 1234"));
        // best-effort：任何一步失败都不算错误。
        assert!(command.ends_with("|| true"));
        assert!(!command.contains("kill -9"));
    }

    #[test]
    fn kill_command_quotes_state_path() {
        let command = kill_server_command(7, "/srv/it's/server.json");
        assert!(command.contains("grep -qxF -- '/srv/it'\\''s/server.json'"));
    }

    #[test]
    fn daemon_commands_are_quoted_and_side_effect_free() {
        let bin = "/srv/app/.qingcode/server/qingcode-server-x86_64";
        let start = start_daemon_command(bin);
        // 后台 + 静默：命令立即返回，且不往通道输出任何东西。
        assert!(start.starts_with("nohup setsid '"));
        assert!(start.contains("' daemon >/dev/null 2>&1 &"));
        assert!(start.ends_with('&'));
        let connect = connect_daemon_command(bin);
        assert!(connect.starts_with("'"));
        assert!(connect.ends_with(" connect --stdio --ensure-daemon"));
        // token 读取限定在运行目录内，失败静默（文件不存在时返回空输出）。
        assert_eq!(
            daemon_token_command(),
            "cat \"$HOME/.qingcode/server/run/token\" 2>/dev/null"
        );
    }

    #[test]
    fn remote_sha256_parser_takes_first_64_hex_token_only() {
        let sha = "a".repeat(64);
        // sha256sum 输出：摘要 + 两个空格 + 文件名（文件名可能含空格）。
        assert_eq!(
            parse_remote_sha256(&format!("{sha}  /srv/app/a b/qingcode-server-x86_64\n")),
            Some(sha.clone())
        );
        // 大写输入归一为小写（Get-FileHash 输出大写）。
        let upper: String = sha.to_ascii_uppercase();
        assert_eq!(parse_remote_sha256(&upper), Some(sha.clone()));
        // 工具缺失 / 文件不存在：空输出或报错文本，一律视为算不出。
        assert_eq!(parse_remote_sha256(""), None);
        assert_eq!(parse_remote_sha256("sha256sum: command not found\n"), None);
        // 摘要长度不对（截断/损坏）不能当真。
        assert_eq!(parse_remote_sha256(&"a".repeat(63)), None);
        assert_eq!(parse_remote_sha256(&format!("zz{}", sha)), None);
        // 匹配比较大小写不敏感；不匹配、空输出都判为需要重新上传。
        assert!(remote_sha256_matches(&format!("{sha}  bin\n"), &sha));
        assert!(remote_sha256_matches(&sha.to_ascii_uppercase(), &sha));
        assert!(!remote_sha256_matches("", &sha));
        assert!(!remote_sha256_matches(&sha, &"b".repeat(64)));
    }

    #[test]
    fn self_check_commands_quote_paths_and_expectations() {
        let command =
            self_check_command("/srv/app/bin dir/qingcode-server-x86_64", &"a".repeat(64));
        assert!(command.contains("self-check --expect-sha256"));
        assert!(command.contains("'/srv/app/bin dir/qingcode-server-x86_64'"));
        let script = windows_self_check_script(
            r"D:\app\qingcode-server-windows-x86_64.exe",
            &"a".repeat(64),
        );
        // 外部 exe 的退出码必须显式转成 PowerShell 脚本退出码，否则失败被吞。
        assert!(script.contains("if ($LASTEXITCODE -ne 0) { exit 1 }"));
        assert!(script.contains(r"& 'D:\app\qingcode-server-windows-x86_64.exe'"));
    }

    #[test]
    fn legacy_agent_cleanup_verifies_identity_and_removes_only_state_file() {
        let command = legacy_agent_cleanup_command(1234, "/srv/app/.qingcode/agent/agent.json");
        // 与 kill_server_command 同构的身份校验，但匹配的是旧二进制名。
        assert!(command.contains("/proc/1234/cmdline"));
        assert!(command.contains("grep -q -- qingcode-agent"));
        assert!(!command.contains("grep -q -- qingcode-server"));
        // 只删旧状态文件本身，绝不能 rm 整个 .qingcode/agent 目录。
        assert!(command.contains("rm -f -- '/srv/app/.qingcode/agent/agent.json'"));
        assert!(!command.contains("rm -rf"));
        assert!(!command.contains("rm -r "));
        // 身份对不上时无副作用：命令包在 if 里而不是 || true 链。
        assert!(command.starts_with("if test -r /proc/1234/cmdline"));
        assert!(command.trim_end().ends_with("fi"));

        let script = windows_legacy_agent_cleanup_script(7, r"D:\app\.qingcode\agent\agent.json");
        assert!(script.contains("qingcode-agent*"));
        assert!(script.contains("Stop-Process -Id 7"));
        assert!(script.contains("Remove-Item -LiteralPath $state -Force"));
    }

    #[test]
    fn remote_sha256_commands_reference_the_binary_only() {
        let command = remote_sha256_command("/srv/app/bin/qingcode-server-x86_64");
        assert!(command.contains("sha256sum -- '/srv/app/bin/qingcode-server-x86_64'"));
        // 只取行首 64 个字符，不受文件名空格影响。
        assert!(command.contains("cut -c1-64"));
        let script = windows_remote_sha256_script(r"D:\app\bin.exe");
        assert!(script.contains("Get-FileHash"));
        assert!(script.contains(r"'D:\app\bin.exe'"));
    }

    #[test]
    fn windows_stop_processes_script_matches_exact_executable_path() {
        let script =
            windows_stop_for("/D:/code/app/.qingcode/server/qingcode-server-windows-x86_64.exe");
        // 精确匹配可执行文件完整路径（大小写不敏感），不按进程名一刀切。
        assert!(
            script.contains(r"'D:\code\app\.qingcode\server\qingcode-server-windows-x86_64.exe'")
        );
        assert!(script.contains("$_.ExecutablePath -ieq $target"));
        assert!(script.contains("Stop-Process -Id $_.ProcessId -Force"));
        assert!(!script.contains("Name -like"));
        // 非 Windows 路径不生成脚本。
        assert!(windows_stop_for("/srv/app/bin/qingcode-server-x86_64").is_empty());
    }

    #[test]
    fn connect_existing_commands_do_not_ensure_daemon() {
        // 升级淘汰路径只连已有 daemon，绝不能顺手拉起旧版实例。
        let unix = connect_daemon_command_existing("/srv/bin/qingcode-server");
        assert!(unix.ends_with(" connect --stdio"));
        assert!(!unix.contains("--ensure-daemon"));
        let windows = windows_connect_daemon_command_existing("/D:/app/qingcode-server.exe");
        assert_eq!(windows, "\"D:/app/qingcode-server.exe\" connect --stdio");
        assert!(!windows.contains("--ensure-daemon"));
    }
}
