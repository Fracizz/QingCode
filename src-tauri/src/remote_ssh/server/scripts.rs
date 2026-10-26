//! 远端脚本与命令的构造（unix shell / Windows PowerShell，纯函数），
//! 以及远端 sha256 输出的解析与本地摘要计算。

use super::paths::windows_host_path;
use super::*;

/// 项目 serve 日志（`.qingcode/server/serve.log`）的截断阈值：启动前超过
/// 1MB 就先删掉重建，日志才是有界的，长期开着的仓库不会把它堆成巨文件。
pub(crate) const SERVE_LOG_TRUNCATE_BYTES: u64 = 1024 * 1024;

/// 家目录不可用（为空、不是绝对路径或是根目录）时准备脚本的退出码。
pub(crate) const PREPARE_HOME_INVALID_EXIT: u32 = 3;

/// Unix：一次往返完成「读家目录 + 创建 `~/.qingcode/server/<version>`」，
/// 最后输出家目录。每一级用 umask 与显式 chmod 收紧到 0700。家目录为空、
/// 非绝对路径或是 `/` 时不建任何目录，直接以 [`PREPARE_HOME_INVALID_EXIT`] 退出；
/// 调用方仍会校验输出并 canonicalize 安装目录。
pub(crate) fn prepare_private_server_dirs_command(version: &str) -> String {
    format!(
        "h=\"$HOME\"; case \"$h\" in /?*) ;; *) exit {invalid};; esac; \
         umask 077; d=\"$h/.qingcode\"; v={version}; \
         mkdir -p -- \"$d\" \"$d/server\" \"$d/server/$v\" \
         && chmod 700 -- \"$d\" \"$d/server\" \"$d/server/$v\" || exit 4; \
         printf '%s\\n' \"$h\"",
        invalid = PREPARE_HOME_INVALID_EXIT,
        version = shell_quote(version),
    )
}

/// Windows：一次往返完成「读 `%USERPROFILE%` + 创建 server 版本目录」，最后
/// 输出家目录。`%USERPROFILE%` 默认只允许当前用户访问，创建时沿用该 ACL；
/// 只接受盘符路径，UNC / 相对路径直接以 [`PREPARE_HOME_INVALID_EXIT`] 退出。
///
/// 走 .NET 的 `CreateDirectory` 而不是 `New-Item`：`New-Item` 没有
/// `-LiteralPath` 参数（只有 `-Path`），而 `-Path` 会把 `[` / `]` 当通配符。
pub(crate) fn windows_prepare_server_dirs_script(version: &str) -> String {
    format!(
        r"$ErrorActionPreference = 'Stop'
$h = $env:USERPROFILE
if (-not $h -or $h -notmatch '^[A-Za-z]:\\.') {{ exit {invalid} }}
$d = Join-Path $h '.qingcode'
@($d, (Join-Path $d 'server'), (Join-Path $d 'server\{version}')) | ForEach-Object {{ [System.IO.Directory]::CreateDirectory($_) | Out-Null }}
$h",
        invalid = PREPARE_HOME_INVALID_EXIT,
        version = powershell_literal(version),
    )
}

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

/// Unix：按可执行文件路径精确结束旧版项目内 server/daemon。只读
/// `/proc/<pid>/exe`，不会执行目标文件；用于迁移时清理旧二进制。
pub(crate) fn kill_processes_by_executable_command(bin: &str) -> String {
    let bin = shell_quote(bin);
    format!(
        "for exe in /proc/[0-9]*/exe; do \
         [ \"$(readlink -- \"$exe\" 2>/dev/null)\" = {bin} ] || continue; \
         pid=${{exe#/proc/}}; pid=${{pid%/exe}}; kill \"$pid\" 2>/dev/null || true; \
         done; true"
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

/// 确保 daemon 在跑并输出会话 token：一次 exec 完成「读 token / 缺席即拉起 /
/// 等就绪」。直接 exec 二进制本体，Windows 上不经 PowerShell（真机每次冷启动
/// 约 2.5s）；daemon 由二进制自己脱离会话拉起（unix `setsid`，Windows
/// `CREATE_BREAKAWAY_FROM_JOB`）。token 只出现在 stdout，不进命令行。
pub(crate) fn daemon_token_command(bin: &str) -> String {
    format!("{} daemon-token --ensure-daemon", shell_quote(bin))
}

/// Windows 版 [`daemon_token_command`]，程序路径写法同 connect 代理。
pub(crate) fn windows_daemon_token_command(remote_bin: &str) -> String {
    format!(
        "{} daemon-token --ensure-daemon",
        windows_exec_program(remote_bin)
    )
}

/// Windows：connect 代理的 exec 命令——**不经过 PowerShell 包装**，直接 exec
/// 二进制本体。PS 的启动噪声（`#< CLIXML`、模块加载进度流）会混进 stdout
/// 破坏二进制帧流；远端默认 shell 对原生进程是句柄直通，帧流原样可达。
pub(crate) fn windows_connect_daemon_command(remote_bin: &str) -> String {
    format!(
        "{} connect --stdio --ensure-daemon",
        windows_exec_program(remote_bin)
    )
}

/// 只连已有 daemon 的 Windows 代理命令（不会拉起新实例），用于升级前淘汰旧实例。
pub(crate) fn windows_connect_daemon_command_existing(remote_bin: &str) -> String {
    format!("{} connect --stdio", windows_exec_program(remote_bin))
}

/// exec 命令里的程序路径，要同时适配 OpenSSH 的三种默认 shell。
///
/// 反斜杠转正斜杠并去 POSIX 前导斜杠：`/D:/x/y.exe` → `D:/x/y.exe`，Git Bash
/// 不会把反斜杠当转义。路径只含安全字符时**不加引号**：默认 shell 是
/// PowerShell 时，`"D:/x/y.exe" connect` 是「字符串表达式 + 多余参数」，直接
/// 报语法错误，daemon 永远连不上；裸路径则 cmd / PowerShell / Git Bash 都按
/// 程序执行。含空格等字符时只能加引号（cmd / Git Bash 可用）。
fn windows_exec_program(remote_bin: &str) -> String {
    let forward = remote_bin.trim_start_matches('/').replace('\\', "/");
    let bare = !forward.is_empty()
        && forward
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/:._-".contains(&byte));
    if bare {
        forward
    } else {
        format!("\"{forward}\"")
    }
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

/// self-check 未通过时组合脚本的退出码，与启动 serve 阶段的失败区分开。
pub(crate) const SELF_CHECK_FAILED_EXIT: u32 = 41;

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
if ($LASTEXITCODE -ne 0) {{ exit {failed} }}",
        bin = powershell_literal(bin),
        sha = powershell_literal(expected_sha256),
        failed = SELF_CHECK_FAILED_EXIT,
    )
}

/// Unix：一次往返完成「收紧权限 → self-check → 启动 serve」。self-check
/// 失败以 [`SELF_CHECK_FAILED_EXIT`] 退出，绝不会继续启动未通过校验的二进制。
pub(crate) fn self_check_then_deploy_command(
    bin: &str,
    expected_sha256: &str,
    deploy: &str,
) -> String {
    format!(
        "chmod 700 -- {bin} 2>/dev/null; {check} || exit {failed}; {deploy}",
        bin = shell_quote(bin),
        check = self_check_command(bin, expected_sha256),
        failed = SELF_CHECK_FAILED_EXIT,
    )
}

/// Windows：self-check 脚本与部署脚本拼成一次 PowerShell 往返；self-check
/// 失败时脚本在部署前以 [`SELF_CHECK_FAILED_EXIT`] 退出。
pub(crate) fn windows_self_check_then_deploy_script(
    bin: &str,
    expected_sha256: &str,
    deploy: &str,
) -> String {
    format!(
        "{}\n{deploy}",
        windows_self_check_script(bin, expected_sha256)
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
    use super::super::paths::{server_binary_file_name, server_install_dir};
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
            format!(
                "{}/{}",
                server_install_dir("/C:/Users/dev", qingcode_server::SERVER_VERSION),
                server_binary_file_name(true, "aarch64")
            ),
            format!(
                "/C:/Users/dev/.qingcode/server/{}/qingcode-server-windows-aarch64.exe",
                qingcode_server::SERVER_VERSION
            )
        );
        let script = windows_deploy_for(
            "/C:/Users/dev/.qingcode/server/0.1.13/qingcode-server-windows-x86_64.exe",
            "/D:/code/app",
            "/D:/code/app/.qingcode/server/server.json",
            "/D:/code/app/.qingcode/server/serve.log",
        )
        .unwrap();
        assert!(script
            .contains(r"C:\Users\dev\.qingcode\server\0.1.13\qingcode-server-windows-x86_64.exe"));
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
        let connect = connect_daemon_command(bin);
        assert!(connect.starts_with("'"));
        assert!(connect.ends_with(" connect --stdio --ensure-daemon"));
        // token 由二进制自己确保 daemon 后输出：一次 exec，不经 shell 脚本。
        assert_eq!(
            daemon_token_command(bin),
            format!("'{bin}' daemon-token --ensure-daemon")
        );
        assert_eq!(
            windows_daemon_token_command("/C:/Users/dev/bin.exe"),
            "C:/Users/dev/bin.exe daemon-token --ensure-daemon"
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
        assert!(script.contains("if ($LASTEXITCODE -ne 0) { exit 41 }"));
        assert!(script.contains(r"& 'D:\app\qingcode-server-windows-x86_64.exe'"));
    }

    #[test]
    fn self_check_then_deploy_stops_before_starting_unverified_binary() {
        let sha = "a".repeat(64);
        let deploy = deploy_server_command(
            "/home/dev/.qingcode/server/v/qingcode-server-x86_64",
            "/srv/app",
            "/srv/app/.qingcode/server/server.json",
            "/srv/app/.qingcode/server/serve.log",
        );
        let command = self_check_then_deploy_command(
            "/home/dev/.qingcode/server/v/qingcode-server-x86_64",
            &sha,
            &deploy,
        );
        // 顺序：收紧权限 → 自检（失败即退出 41）→ 启动 serve。
        let check_at = command.find(" self-check ").unwrap();
        let exit_at = command.find("|| exit 41;").unwrap();
        let serve_at = command.find(" serve --root ").unwrap();
        assert!(command.starts_with("chmod 700 -- '"));
        assert!(check_at < exit_at && exit_at < serve_at);

        let script = windows_self_check_then_deploy_script(
            r"C:\Users\dev\.qingcode\server\v\qingcode-server-windows-x86_64.exe",
            &sha,
            "& $bin serve --detach",
        );
        let exit_at = script.find("{ exit 41 }").unwrap();
        assert!(exit_at < script.find("serve --detach").unwrap());
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
        assert_eq!(windows, "D:/app/qingcode-server.exe connect --stdio");
        assert!(!windows.contains("--ensure-daemon"));
    }

    #[test]
    fn windows_connect_command_runs_under_powershell_default_shell() {
        // 常规安装路径不加引号：PowerShell 把带引号的首词当字符串表达式，后接参数即语法错误。
        assert_eq!(
            windows_connect_daemon_command(
                "/C:/Users/dev/.qingcode/server/0.1.13/qingcode-server-windows-x86_64.exe"
            ),
            "C:/Users/dev/.qingcode/server/0.1.13/qingcode-server-windows-x86_64.exe connect --stdio --ensure-daemon"
        );
        // 反斜杠统一转正斜杠，Git Bash 不会当转义吃掉。
        assert_eq!(
            windows_connect_daemon_command(r"C:\Users\dev\bin.exe"),
            "C:/Users/dev/bin.exe connect --stdio --ensure-daemon"
        );
        // 含空格只能加引号，cmd / Git Bash 下仍可执行。
        assert_eq!(
            windows_connect_daemon_command("/C:/Users/John Doe/bin.exe"),
            "\"C:/Users/John Doe/bin.exe\" connect --stdio --ensure-daemon"
        );
    }

    #[test]
    fn private_server_directory_commands_quote_and_tighten_every_component() {
        let command = prepare_private_server_dirs_command("0.1.13");
        // 家目录为空、相对路径或 `/` 时不建目录直接退出。
        assert!(command.contains("case \"$h\" in /?*) ;; *) exit 3;; esac;"));
        assert!(command.contains("umask 077;"));
        assert!(command.contains("v='0.1.13';"));
        assert!(command.contains(
            "mkdir -p -- \"$d\" \"$d/server\" \"$d/server/$v\" && chmod 700 -- \"$d\" \"$d/server\" \"$d/server/$v\""
        ));
        // 家目录在最后输出，供调用方解析。
        assert!(command.ends_with("printf '%s\\n' \"$h\""));

        let script = windows_prepare_server_dirs_script("0.1.13");
        // New-Item 不接受 -LiteralPath；误用它会让脚本在远端以 exit 1 失败。
        assert!(!script.contains("New-Item"));
        assert!(!script.contains("-LiteralPath"));
        assert!(script.contains("[System.IO.Directory]::CreateDirectory($_)"));
        assert!(script.contains(r"(Join-Path $d 'server\0.1.13')"));
        assert!(script.contains(r"$h -notmatch '^[A-Za-z]:\\.') { exit 3 }"));
        assert!(script.ends_with("\n$h"));
    }

    #[test]
    fn legacy_process_cleanup_matches_exact_executable_without_running_it() {
        let command = kill_processes_by_executable_command(
            "/srv/app/.qingcode/server/qingcode-server-x86_64",
        );
        assert!(command.contains("/proc/[0-9]*/exe"));
        assert!(command.contains("readlink"));
        assert!(command.contains("'/srv/app/.qingcode/server/qingcode-server-x86_64'"));
        assert!(command.contains("kill \"$pid\""));
        // 清理命令本身不能包含执行目标二进制、self-check 或 connect。
        assert!(!command.contains(" self-check"));
        assert!(!command.contains(" connect"));
    }
}
