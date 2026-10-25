//! 部署编排：发现存活 server / 上传-校验-启动 / 等就绪，以及
//! (连接, 根) 粒度的 slot 缓存、幂等跳过与部署退避。

use super::daemon::{daemon_downgrade_retry_ready, ensure_remote_daemon};
use super::download::{locate_local_server_binary, locate_local_server_binary_with};
use super::paths::{
    can_reuse_discovered_server, legacy_agent_state_path, legacy_project_agent_binary_path,
    legacy_project_server_binary_path, parse_server_state, project_server_dir_path,
    remote_roots_equivalent, server_binary_file_name, server_gitignore_path, server_install_dir,
    server_serve_log_path, server_state_path, user_server_root, windows_remote_path,
};
use super::scripts::{
    deploy_server_command, kill_processes_by_executable_command, private_server_dirs_command,
    remote_home_command, remote_sha256_command, remote_sha256_matches, self_check_command,
    sha256_of_file_cached, windows_create_server_dirs_script, windows_deploy_for,
    windows_remote_home_script, windows_remote_sha256_script, windows_remove_for,
    windows_self_check_script, windows_stop_for,
};
use super::serve::ping_server;
use super::*;
use qingcode_server::SERVER_VERSION;

/// 等待 server 启动就绪（状态文件出现且 ping 通过）的总时限。
const AGENT_READY_TIMEOUT: Duration = Duration::from_secs(15);
/// server 启动就绪轮询间隔。
const AGENT_READY_POLL: Duration = Duration::from_millis(300);
/// 部署退避阈值：同一 (连接, 根) 连续这么多次完整部署都等不到就绪，
/// 说明不是瞬时抖动（典型如 sshd 禁了 TCP 转发），缓存成不可用等人介入。
pub(crate) const SERVER_DEPLOY_BACKOFF_THRESHOLD: u32 = 2;
const SERVER_STATE_GITIGNORE: &[u8] = b"*\n";
const SERVER_STATE_GITIGNORE_MAX_BYTES: u64 = 64 * 1024;

async fn exec_on_root(
    manager: &SshManager,
    root: &RegisteredRoot,
    unix_command: &str,
    windows_script: &str,
) -> Result<RemoteExecResult, String> {
    manager
        .exec_remote_shell(
            &root.uri,
            unix_command,
            windows_script,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await
}

/// 确保项目状态目录存在，并在任何读写前确认真实路径仍位于项目根内。
///
/// `.qingcode` 与 `.qingcode/server` 分两步创建和 canonicalize：前者若是指向
/// 项目外的符号链接，在创建子目录前就会被拒绝；后者同样不能跳转到项目根外
/// 或 `.qingcode` 之外。目录通过校验后才创建 `*` 忽略文件，防止 token 状态和
/// 日志被提交。
async fn ensure_project_server_state_dir(
    sftp: &SftpSession,
    root: &RegisteredRoot,
) -> Result<(), ServerDeployError> {
    let root_path = root.canonical_path.trim_end_matches('/');
    let windows = windows_native_path(&root.canonical_path).is_some();
    let qingcode_dir = format!("{root_path}/.qingcode");
    let server_dir = project_server_dir_path(root_path);

    let _ = sftp.create_dir(qingcode_dir.clone()).await;
    let resolved_qingcode = sftp
        .canonicalize(qingcode_dir.clone())
        .await
        .map_err(|error| format!("项目 .qingcode 目录不可用：{error}"))?;
    if !remote_path_is_within(&resolved_qingcode, &root.canonical_path)
        || !remote_roots_equivalent(&resolved_qingcode, &qingcode_dir, windows)
    {
        return Err(ServerDeployError::permanent(
            "项目 .qingcode 目录跳出了项目根",
        ));
    }

    let _ = sftp.create_dir(server_dir.clone()).await;
    let resolved_server = sftp
        .canonicalize(server_dir.clone())
        .await
        .map_err(|error| format!("项目 server 状态目录不可用：{error}"))?;
    if !remote_path_is_within(&resolved_server, &root.canonical_path)
        || !remote_roots_equivalent(&resolved_server, &server_dir, windows)
    {
        return Err(ServerDeployError::permanent(
            "项目 server 状态目录跳出了项目根",
        ));
    }

    let gitignore = server_gitignore_path(root_path);
    match sftp
        .open_with_flags(gitignore.clone(), remote_write_flags(true))
        .await
    {
        Ok(mut file) => {
            file.write_all(SERVER_STATE_GITIGNORE)
                .await
                .map_err(|error| format!("写入项目 server .gitignore 失败：{error}"))?;
            file.shutdown()
                .await
                .map_err(|error| format!("完成项目 server .gitignore 写入失败：{error}"))?;
        }
        // 已有文件不覆盖用户内容，但必须确认其中包含 `*`，否则 token 状态和
        // 日志仍可能被提交。文件过大或无法读取时拒绝继续部署。
        Err(create_error) => match sftp.metadata(gitignore.clone()).await {
            Ok(metadata)
                if metadata
                    .size
                    .is_none_or(|size| size <= SERVER_STATE_GITIGNORE_MAX_BYTES) =>
            {
                let existing = sftp
                    .read(gitignore)
                    .await
                    .map_err(|error| format!("读取项目 server .gitignore 失败：{error}"))?;
                if !gitignore_excludes_directory(&existing) {
                    return Err(ServerDeployError::permanent(
                        "项目 .qingcode/server/.gitignore 必须包含一行 `*`，以阻止状态 token 和日志进入版本库",
                    ));
                }
            }
            Ok(_) => {
                return Err(ServerDeployError::permanent(
                    "项目 .qingcode/server/.gitignore 过大，拒绝继续部署",
                ));
            }
            Err(_) => {
                return Err(format!("创建项目 server .gitignore 失败：{create_error}").into());
            }
        },
    }
    Ok(())
}

fn gitignore_excludes_directory(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes)
        .ok()
        .is_some_and(|text| text.lines().any(|line| line.trim() == "*"))
}

/// 在已有状态文件中发现存活 server。只有状态版本、项目根、本地可信摘要与
/// 用户私有安装目录中的远端摘要全部匹配时才复用；任何一项缺失都重新部署。
///
/// `local_sha256 = None` 时直接拒绝发现，绝不能仅凭项目内 `server.json`
/// 的版本号去连接或执行 `<项目>/.qingcode/server/` 中的文件。
async fn try_discover_server(
    manager: &SshManager,
    connection_id: &str,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
    local_sha256: Option<&str>,
    remote_bin: &str,
) -> Option<ServerEndpoint> {
    let local_sha256 = local_sha256?;
    let state_path = server_state_path(&root.canonical_path);
    let metadata = sftp.metadata(state_path.clone()).await.ok()?;
    if metadata.is_dir() {
        return None;
    }
    let bytes = sftp.read(state_path.clone()).await.ok()?;
    let state = parse_server_state(&bytes).ok()?;
    let windows = windows_native_path(&root.canonical_path).is_some();
    let remote_matches = remote_binary_sha_matches(manager, root, remote_bin, local_sha256).await;
    if !can_reuse_discovered_server(
        &state.version,
        &state.root,
        &root.canonical_path,
        windows,
        Some(local_sha256),
        remote_matches,
    ) {
        return None;
    }
    let endpoint = ServerEndpoint {
        port: state.port,
        token: state.token,
        daemon: None,
    };
    // ping 之前进入握手；失败则调用方继续安装。
    server_status::note_server_activity(
        manager,
        app,
        root,
        connection_id,
        server_status::ServerPhase::Handshaking,
    );
    ping_server(manager, connection_id, &endpoint).await.ok()?;
    Some(endpoint)
}

/// 解析远端用户家目录并统一成 SFTP 路径。Windows 只接受盘符路径，
/// UNC / 相对路径直接拒绝，避免把共享目录当成用户私有安装位置。
async fn resolve_server_home(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<String, ServerDeployError> {
    let windows = windows_native_path(&root.canonical_path).is_some();
    let result = exec_on_root(
        manager,
        root,
        remote_home_command(),
        windows_remote_home_script(),
    )
    .await
    .map_err(|error| ServerDeployError::permanent(format!("无法读取远端用户家目录：{error}")))?;
    if result.exit_code != 0 {
        return Err(ServerDeployError::permanent(format!(
            "无法读取远端用户家目录（退出码 {}）",
            result.exit_code
        )));
    }
    let raw = result.stdout.trim();
    if raw.is_empty() {
        return Err(ServerDeployError::permanent("远端用户家目录为空"));
    }
    let home = if windows {
        windows_remote_path(raw).ok_or_else(|| {
            ServerDeployError::permanent("Windows 远端 USERPROFILE 不是受支持的盘符路径")
        })?
    } else {
        validate_remote_path(raw)
            .map_err(|error| ServerDeployError::permanent(format!("远端家目录无效：{error}")))?;
        normalize_remote_path(raw)
    };
    if home == "/" {
        return Err(ServerDeployError::permanent(
            "远端家目录不能是根目录，无法建立用户私有安装目录",
        ));
    }
    Ok(home)
}

/// 创建并验证 `~/.qingcode/server/<version>`。Unix 上每一级都收紧到 0700；
/// Windows 依赖 `%USERPROFILE%` 的用户私有 ACL。canonicalize 后仍必须位于
/// 家目录内，拒绝通过符号链接把安装目录重定向到外部位置。
async fn prepare_server_install_dir(
    manager: &SshManager,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    home: &str,
) -> Result<String, ServerDeployError> {
    let windows = windows_native_path(&root.canonical_path).is_some();
    let qingcode_dir = format!("{}/.qingcode", home.trim_end_matches('/'));
    let server_root = user_server_root(home);
    let install_dir = server_install_dir(home, SERVER_VERSION);
    let dirs = vec![
        qingcode_dir.clone(),
        server_root.clone(),
        install_dir.clone(),
    ];
    if windows {
        let native_dirs = dirs
            .iter()
            .map(|dir| {
                windows_host_path(dir)
                    .ok_or_else(|| ServerDeployError::permanent("Windows server 安装路径无效"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let result = exec_on_root(
            manager,
            root,
            "",
            &windows_create_server_dirs_script(&native_dirs),
        )
        .await
        .map_err(|error| {
            ServerDeployError::permanent(format!("创建 Windows server 安装目录失败：{error}"))
        })?;
        if result.exit_code != 0 {
            return Err(ServerDeployError::permanent(format!(
                "创建 Windows server 安装目录失败（退出码 {}）",
                result.exit_code
            )));
        }
    } else {
        let result = exec_on_root(manager, root, &private_server_dirs_command(&dirs), "")
            .await
            .map_err(|error| {
                ServerDeployError::permanent(format!("创建用户私有 server 目录失败：{error}"))
            })?;
        if result.exit_code != 0 {
            return Err(ServerDeployError::permanent(format!(
                "创建或收紧用户私有 server 目录失败（退出码 {}）",
                result.exit_code
            )));
        }
    }
    let resolved_home = sftp
        .canonicalize(home.to_string())
        .await
        .map_err(|error| ServerDeployError::permanent(format!("远端家目录不可用：{error}")))?;
    let resolved_install = sftp
        .canonicalize(install_dir)
        .await
        .map_err(|error| ServerDeployError::permanent(format!("server 安装目录不可用：{error}")))?;
    if resolved_install == resolved_home
        || !remote_path_is_within(&resolved_install, &resolved_home)
    {
        return Err(ServerDeployError::permanent(
            "server 安装目录不在远端用户家目录内",
        ));
    }
    Ok(resolved_install)
}

/// 已通过本地可信文件定位的目标；远端路径必须位于用户私有版本目录。
struct ServerInstallTarget<'a> {
    home: &'a str,
    install_dir: &'a str,
    remote_bin: &'a str,
    local_sha256: &'a str,
}

/// 上传 server 二进制到用户私有版本目录，临时文件 + rename 原子落位。
///
/// 幂等优化：上传前先在远端算已存在二进制的 sha256，与本地一致就跳过上传。
/// 之前每次部署失败重试都是全量 SFTP 上传（ping 打不通时变成热循环：上传
/// 几十 MB → 新 serve 因旧实例 rc=3 退出 → 15s 轮询超时 → 再来一遍）。
/// sha256 逐字节一致则版本必然一致；远端算不出摘要或对不上时照常全量上传。
async fn upload_server_binary(
    manager: &SshManager,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    local: &Path,
    target: &ServerInstallTarget<'_>,
) -> Result<bool, String> {
    if remote_binary_sha_matches(manager, root, target.remote_bin, target.local_sha256).await {
        return Ok(false);
    }
    // 上传前再确认目录仍在家目录内（防止 root 被符号链接重定向）。
    let resolved_dir = sftp
        .canonicalize(target.install_dir.to_string())
        .await
        .map_err(|error| format!("server 部署目录不可用：{error}"))?;
    let resolved_home = sftp
        .canonicalize(target.home.to_string())
        .await
        .map_err(|error| format!("远端家目录不可用：{error}"))?;
    if !remote_path_is_within(&resolved_dir, &resolved_home) {
        return Err("server 部署目录跳出了远端用户家目录".to_string());
    }

    let bytes =
        std::fs::read(local).map_err(|error| format!("读取本地 server 二进制失败：{error}"))?;
    // SFTP v3 的 rename 不覆盖已存在目标，先写临时文件再原子替换。
    let temp = format!(
        "{}/qingcode-server.tmp-{}",
        resolved_dir,
        uuid::Uuid::new_v4().simple()
    );
    let write_result: Result<(), String> = async {
        let mut file = sftp
            .open_with_flags(temp.clone(), remote_write_flags(true))
            .await
            .map_err(|error| format!("创建远端临时文件失败：{error}"))?;
        for chunk in bytes.chunks(64 * 1024) {
            file.write_all(chunk)
                .await
                .map_err(|error| format!("上传 server 二进制失败：{error}"))?;
        }
        file.shutdown()
            .await
            .map_err(|error| format!("完成 server 上传失败：{error}"))?;
        Ok(())
    }
    .await;
    if let Err(error) = write_result {
        let _ = tokio::time::timeout(Duration::from_secs(2), sftp.remove_file(temp)).await;
        return Err(error);
    }
    // 目标摘要已不匹配，目标文件不可信；这里只按可执行文件路径清理进程，
    // 绝不执行它请求 shutdown。Windows 由此释放文件锁，Unix 也避免旧
    // serve/daemon 继续运行旧代码。
    stop_processes_for_binary(manager, root, target.remote_bin).await;
    replace_remote_binary(manager, sftp, root, &temp, target.remote_bin).await?;
    Ok(true)
}

/// 按目标路径清理 server/daemon 进程。只读取进程元数据或 PowerShell
/// `ExecutablePath`，不会执行待替换的二进制。
async fn stop_processes_for_binary(manager: &SshManager, root: &RegisteredRoot, remote_bin: &str) {
    let windows = windows_native_path(&root.canonical_path).is_some();
    let command = if windows {
        String::new()
    } else {
        kill_processes_by_executable_command(remote_bin)
    };
    let script = if windows {
        windows_stop_for(remote_bin)
    } else {
        String::new()
    };
    if command.is_empty() && script.is_empty() {
        return;
    }
    let _ = exec_on_root(manager, root, &command, &script).await;
    // 进程退出与句柄释放有毫秒级延迟，给随后 rename 留余量。
    tokio::time::sleep(Duration::from_millis(300)).await;
}

/// 用临时文件原子替换目标二进制。
///
/// SFTP v3 的 rename 不覆盖已存在目标，所以先重命名、失败再删旧文件重试。
/// Windows 上进程退出后句柄释放、杀毒软件扫描都可能让删除/重命名短暂失败，
/// 因此带退避重试；仍失败时给出可操作的错误信息。
async fn replace_remote_binary(
    manager: &SshManager,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    temp: &str,
    remote_bin: &str,
) -> Result<(), String> {
    let mut last_error = String::new();
    for attempt in 0..4u64 {
        match sftp.rename(temp.to_string(), remote_bin.to_string()).await {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error.to_string(),
        }
        // 目标已存在（SFTP v3 rename 拒绝覆盖）：清掉旧文件后再 rename。
        let _ = exec_on_root(
            manager,
            root,
            &format!("rm -f -- {}", shell_quote(remote_bin)),
            &windows_remove_for(remote_bin),
        )
        .await;
        tokio::time::sleep(Duration::from_millis(200 * (attempt + 1))).await;
    }
    Err(format!(
        "提交 server 二进制失败（目标文件可能仍被远端进程占用，请先停止远端 server 后重试）：{last_error}"
    ))
}

/// 远端已部署二进制与本地摘要是否一致。任何一步失败（工具缺失、输出异常）
/// 都按「不一致」处理，调用方回退全量上传。
async fn remote_binary_sha_matches(
    manager: &SshManager,
    root: &RegisteredRoot,
    remote_bin: &str,
    local_sha256: &str,
) -> bool {
    let windows = windows_native_path(&root.canonical_path).is_some();
    let windows_script = if windows {
        windows_host_path(remote_bin)
            .as_deref()
            .map(windows_remote_sha256_script)
            .unwrap_or_default()
    } else {
        String::new()
    };
    let Ok(result) = exec_on_root(
        manager,
        root,
        &remote_sha256_command(remote_bin),
        &windows_script,
    )
    .await
    else {
        return false;
    };
    remote_sha256_matches(&result.stdout, local_sha256)
}

/// 先在不执行目标文件的前提下用远端 `sha256sum` / `Get-FileHash` 比对本地
/// 摘要，只有一致后才 exec `self-check` 探测 noexec。这样损坏、被替换或
/// 来源不明的文件永远不会进入执行阶段。失败按 permanent 处理。
async fn verify_remote_binary(
    manager: &SshManager,
    root: &RegisteredRoot,
    remote_bin: &str,
    local_sha256: &str,
) -> Result<(), ServerDeployError> {
    if !remote_binary_sha_matches(manager, root, remote_bin, local_sha256).await {
        return Err(ServerDeployError::permanent(
            "远端 server 二进制 SHA-256 与本地可信文件不一致，已拒绝执行",
        ));
    }
    // 用户目录与文件都只允许当前用户访问；跳过上传的旧文件也可能权限被改动。
    if windows_native_path(&root.canonical_path).is_none() {
        let _ = manager
            .exec_command(
                &root.uri,
                &format!("chmod 700 -- {}", shell_quote(remote_bin)),
                None,
                true,
                REMOTE_EXEC_TIMEOUT,
            )
            .await;
    }
    let windows_script = windows_host_path(remote_bin)
        .map(|path| windows_self_check_script(&path, local_sha256))
        .unwrap_or_default();
    let result = manager
        .exec_remote_shell(
            &root.uri,
            &self_check_command(remote_bin, local_sha256),
            &windows_script,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await
        .map_err(|error| {
            ServerDeployError::permanent(format!("远端 server 自检执行失败：{error}"))
        })?;
    if result.exit_code != 0 {
        let detail = self_check_failure_detail(&result.stderr, result.exit_code);
        return Err(ServerDeployError::permanent(format!(
            "远端服务程序自检未通过（{detail}）：用户私有安装目录可能不允许执行，或文件在摘要校验后被替换。请重新连接以重新部署"
        )));
    }
    Ok(())
}

/// 自检失败的用户可见摘要：stderr 常是整段 CLI 用法说明（如远端残留旧版
/// 二进制不认识 self-check 时），属开发者信息，这里只保留首个非空行并截断；
/// 没有 stderr 时退回退出码。完整输出不进界面。
fn self_check_failure_detail(stderr: &str, exit_code: u32) -> String {
    const MAX_LINE_CHARS: usize = 60;
    let line = stderr.lines().map(str::trim).find(|line| !line.is_empty());
    match line {
        Some(line) if line.chars().count() <= MAX_LINE_CHARS => line.to_string(),
        Some(line) => {
            let mut head: String = line.chars().take(MAX_LINE_CHARS).collect();
            head.push('…');
            head
        }
        None => format!("退出码 {exit_code}"),
    }
}

/// 清理旧版项目内安装：只按路径结束进程并删除文件，绝不执行项目目录中的
/// 二进制。包括改名前的 `qingcode-agent-*`、当前旧布局 `qingcode-server-*`
/// 和旧状态文件。清理失败不影响已经通过校验的新版本安装。
async fn cleanup_legacy_project_install(
    manager: &SshManager,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    arch: &str,
) {
    let windows = windows_native_path(&root.canonical_path).is_some();
    let binaries = [
        legacy_project_server_binary_path(&root.canonical_path, windows, arch),
        legacy_project_agent_binary_path(&root.canonical_path, windows, arch),
    ];
    for binary in binaries {
        stop_processes_for_binary(manager, root, &binary).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), sftp.remove_file(binary)).await;
    }
    let legacy_state = legacy_agent_state_path(&root.canonical_path);
    let _ = tokio::time::timeout(Duration::from_secs(2), sftp.remove_file(legacy_state)).await;
}

/// 等待 server 启动就绪：状态文件出现、可解析且 ping 通过。
async fn wait_server_ready(
    manager: &SshManager,
    connection_id: &str,
    sftp: &SftpSession,
    root: &RegisteredRoot,
) -> Option<ServerEndpoint> {
    let state_path = server_state_path(&root.canonical_path);
    let deadline = Instant::now() + AGENT_READY_TIMEOUT;
    loop {
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(AGENT_READY_POLL).await;
        if let Ok(bytes) = sftp.read(state_path.clone()).await {
            if let Ok(state) = parse_server_state(&bytes) {
                if state.version != SERVER_VERSION
                    || !remote_roots_equivalent(
                        &state.root,
                        &root.canonical_path,
                        windows_native_path(&root.canonical_path).is_some(),
                    )
                {
                    continue;
                }
                let endpoint = ServerEndpoint {
                    port: state.port,
                    token: state.token,
                    daemon: None,
                };
                if ping_server(manager, connection_id, &endpoint).await.is_ok() {
                    return Some(endpoint);
                }
            }
        }
    }
}

/// 部署退避决策：连续失败次数达到阈值后给出的不可用原因（None = 继续按瞬时
/// 处理）。抽成纯函数便于单测。
fn deploy_backoff_reason(failures: u32) -> Option<&'static str> {
    (failures >= SERVER_DEPLOY_BACKOFF_THRESHOLD).then_some(
        "连续多次部署后 server 仍未就绪：请检查远端 sshd 是否允许 TCP 转发（AllowTcpForwarding）、重启远端 server 进程，或断开重连后再试",
    )
}

/// 发现或部署远端 server；不可用时返回原因，调用方回退直连。
///
/// serve 端点就绪后尽力补一步 daemon 传输探测（见 [`ensure_remote_daemon`]）：
/// 探测失败只表示本轮没有 daemon 可用，serve 模式照常返回。
async fn discover_or_deploy_server(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
) -> Result<ServerEndpoint, ServerDeployError> {
    let sftp = manager.open_sftp(connection_id).await?;
    // 发现和启动 serve 都依赖这里的状态文件与日志目录；干净项目必须先创建
    // 并验证项目内目录，再进入 try_discover 或安装流程。
    ensure_project_server_state_dir(&sftp, root).await?;
    // 先解析本地二进制（只查本地、不触发下载）。本地没有可信文件时不做
    // 发现，后续必须下载或由用户提供离线文件。
    let local_candidate = locate_local_server_binary_with(manager, root, false)
        .await
        .ok();
    let windows = windows_native_path(&root.canonical_path).is_some();

    if let Some((arch, local_binary)) = local_candidate.as_ref() {
        let home = resolve_server_home(manager, root).await?;
        let install_dir = prepare_server_install_dir(manager, &sftp, root, &home).await?;
        let remote_bin = format!("{install_dir}/{}", server_binary_file_name(windows, arch));
        let local_sha256 = sha256_of_file_cached(local_binary)
            .await
            .map_err(ServerDeployError::from)?;
        if let Some(mut endpoint) = try_discover_server(
            manager,
            connection_id,
            &sftp,
            root,
            app,
            Some(&local_sha256),
            &remote_bin,
        )
        .await
        {
            cleanup_legacy_project_install(manager, &sftp, root, arch).await;
            endpoint.daemon = ensure_remote_daemon(manager, connection_id, root, &remote_bin).await;
            return Ok(endpoint);
        }
    }

    let (arch, local_binary) = match local_candidate {
        Some(local) => local,
        None => locate_local_server_binary(manager, root).await?,
    };
    let home = resolve_server_home(manager, root).await?;
    let install_dir = prepare_server_install_dir(manager, &sftp, root, &home).await?;
    let remote_bin = format!("{install_dir}/{}", server_binary_file_name(windows, &arch));
    // 上传之前才标 installing；找本地二进制仍算 probing。
    server_status::note_server_activity(
        manager,
        app,
        root,
        connection_id,
        server_status::ServerPhase::Installing,
    );
    // 本地摘要一份两用：幂等跳过上传 + 远端 self-check 期望值。
    let local_sha256 = sha256_of_file_cached(&local_binary)
        .await
        .map_err(ServerDeployError::from)?;
    let target = ServerInstallTarget {
        home: &home,
        install_dir: &install_dir,
        remote_bin: &remote_bin,
        local_sha256: &local_sha256,
    };
    upload_server_binary(manager, &sftp, root, &local_binary, &target)
        .await
        .map_err(ServerDeployError::deploy_stage)?;
    // 先做无执行的 sha256 校验，再 self-check（同时探测 noexec）。
    verify_remote_binary(manager, root, &remote_bin, &local_sha256).await?;
    // 新版本已可信后才清理旧项目目录；清理过程不会执行旧二进制。
    cleanup_legacy_project_install(manager, &sftp, root, &arch).await;
    let state_path = server_state_path(&root.canonical_path);
    let serve_log = server_serve_log_path(&root.canonical_path);
    let command = deploy_server_command(&remote_bin, &root.canonical_path, &state_path, &serve_log);
    let windows_script =
        windows_deploy_for(&remote_bin, &root.canonical_path, &state_path, &serve_log)
            .map_err(ServerDeployError::from)?;
    manager
        .exec_remote_shell(
            &root.uri,
            &command,
            &windows_script,
            true,
            REMOTE_EXEC_TIMEOUT,
        )
        .await
        .map_err(|error| {
            ServerDeployError::deploy_stage(format!("启动远端 server 失败：{error}"))
        })?;
    // serve ping 之前进入握手。
    server_status::note_server_activity(
        manager,
        app,
        root,
        connection_id,
        server_status::ServerPhase::Handshaking,
    );
    let mut endpoint = wait_server_ready(manager, connection_id, &sftp, root)
        .await
        .ok_or_else(|| ServerDeployError::deploy_stage("server 启动超时".to_string()))?;
    endpoint.daemon = ensure_remote_daemon(manager, connection_id, root, &remote_bin).await;
    Ok(endpoint)
}

fn publish_server_if_watched(
    app: Option<&tauri::AppHandle>,
    manager: &SshManager,
    root: &RegisteredRoot,
) {
    if let Some(app) = app {
        server_status::publish_root_state(app, manager, root);
    }
}

/// 读缓存：`Some(Some(..))` 命中端点，`Some(None)` 本次连接内已确定不可用，
/// `None` 表示还没有结论、需要走发现/部署。
fn cached_server_slot(manager: &SshManager, key: &str) -> Option<Option<ServerEndpoint>> {
    let slot = manager.server_slot(key)?;
    if let Some(endpoint) = slot.endpoint {
        return Some(Some(endpoint));
    }
    slot.unavailable_reason.is_some().then_some(None)
}

/// 只取已就绪的 server 端点，不等发现/部署。
///
/// 还没有结论时在后台拉起一轮发现/部署并立即返回 `None`，调用方本次回退
/// 直连。目录扫描与内容搜索走这里：首次进入项目时 watch 监督任务正持有部署
/// 门闩做完整部署（下载、上传、等就绪、daemon 握手可达数十秒），若同步等待，
/// 文件树要等部署结束才出现；而直连只需一次 SFTP 往返。
pub(crate) async fn ready_server_endpoint(
    app: &tauri::AppHandle,
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Option<ServerEndpoint> {
    ensure_server_endpoint_inner(manager, root, Some(app), false)
        .await
        .ok()
        .flatten()
}

/// slot 还没有结论（无端点、无不可用原因）且没有部署在跑时，后台补一轮
/// 发现/部署。状态查询与 server 调用失败后都走这里：否则 slot 停在「正在
/// 探测」却没有任何任务在推进，状态芯片会一直卡住。
pub(crate) fn kick_server_discovery(
    app: &tauri::AppHandle,
    manager: &SshManager,
    root: &RegisteredRoot,
) {
    if !manager.server_enabled() || !root.trusted {
        return;
    }
    let Ok(parsed) = parse_remote_uri(&root.uri) else {
        return;
    };
    if !manager.connection_is_open(&parsed.connection_id) {
        return;
    }
    let key = server_slot_key(&parsed.connection_id, &root.canonical_path);
    if cached_server_slot(manager, &key).is_none() {
        spawn_background_deploy(app, manager, root, &key);
    }
}

/// server 调用失败、端点可能已失联：清掉端点缓存，立即发布当前状态，并在
/// 后台重新发现。此前这里只清缓存：芯片既不更新，也没有任务重新发现，
/// 重新挂载时读到的就是无人处理的「正在探测」。
pub(crate) fn note_server_endpoint_lost(
    app: &tauri::AppHandle,
    manager: &SshManager,
    root: &RegisteredRoot,
    key: &str,
) {
    manager.clear_server_endpoint(key);
    server_status::publish_root_state(app, manager, root);
    kick_server_discovery(app, manager, root);
}

/// 后台跑一轮发现/部署。部署门闩已被占用（通常是 watch 监督任务正在部署）
/// 时不再重复排队，结果落到 slot 后后续操作自然走 server。
fn spawn_background_deploy(
    app: &tauri::AppHandle,
    manager: &SshManager,
    root: &RegisteredRoot,
    key: &str,
) {
    let Ok(gate) = manager.server_gate(key) else {
        return;
    };
    if gate.try_lock().is_err() {
        return;
    }
    let app = app.clone();
    let root = root.clone();
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<SshManager>();
        let _ = ensure_server_endpoint_with_app(&manager, &root, Some(&app)).await;
    });
}

/// 确保（连接, 项目根）对应的 server 端点可用，必要时同步完成发现/部署，
/// 并在 `app` 存在时发布阶段变化（watch 监督和 `ssh_server_restart` 使用）。
///
/// 前置门不满足、server 未部署或任何失败都返回 `Ok(None)`——调用方一律回退
/// 既有直连路径。成功结果缓存在 slot 里，之后走快路径；失败原因同样缓存，
/// 避免每次目录扫描都重复探测部署。
pub(crate) async fn ensure_server_endpoint_with_app(
    manager: &SshManager,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
) -> Result<Option<ServerEndpoint>, String> {
    ensure_server_endpoint_inner(manager, root, app, true).await
}

async fn ensure_server_endpoint_inner(
    manager: &SshManager,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
    wait_for_deploy: bool,
) -> Result<Option<ServerEndpoint>, String> {
    let connection_id = parse_remote_uri(&root.uri)?.connection_id;
    let key = server_slot_key(&connection_id, &root.canonical_path);
    // 未信任项目、总开关关闭：不部署，直接公布直连原因。Windows 远端走 serve。
    if !manager.server_enabled() || !root.trusted {
        publish_server_if_watched(app, manager, root);
        return Ok(None);
    }
    if let Some(cached) = cached_server_slot(manager, &key) {
        // daemon 降级满冷却期后补一次探测：降级只清 daemon 标记，若不重试，
        // daemon 崩溃后这条连接永远回不去 daemon 传输，直到端点整体重建。
        if cached
            .as_ref()
            .is_some_and(|endpoint| endpoint.daemon.is_none())
            && daemon_downgrade_retry_ready(
                manager
                    .server_slot(&key)
                    .and_then(|slot| slot.daemon_downgraded_at),
                Instant::now(),
            )
        {
            retry_downgraded_daemon(manager, &connection_id, root, &key).await;
        }
        manager.set_server_activity(&key, None);
        publish_server_if_watched(app, manager, root);
        return Ok(cached);
    }
    if !wait_for_deploy {
        if let Some(app) = app {
            spawn_background_deploy(app, manager, root, &key);
        }
        return Ok(None);
    }
    // 同一 (连接, 根) 的部署串行执行；拿不到锁的并发调用方等结果落盘后复用。
    let gate = manager.server_gate(&key)?;
    let _guard = gate.lock().await;
    if let Some(cached) = cached_server_slot(manager, &key) {
        manager.set_server_activity(&key, None);
        publish_server_if_watched(app, manager, root);
        return Ok(cached);
    }
    // 新一轮从 probing 开始，清掉上次中断留下的瞬时阶段。
    manager.set_server_activity(&key, None);
    publish_server_if_watched(app, manager, root);
    match discover_or_deploy_server(manager, &connection_id, root, app).await {
        Ok(endpoint) => {
            let mut slot = manager.server_slot(&key).unwrap_or_default();
            slot.endpoint = Some(endpoint.clone());
            slot.unavailable_reason = None;
            slot.activity = None;
            slot.last_failure = None;
            // 部署成功：退避计数清零，下一次失败重新从 1 数起。
            slot.deploy_failures = 0;
            manager.set_server_slot(&key, slot);
            publish_server_if_watched(app, manager, root);
            Ok(Some(endpoint))
        }
        Err(error) => {
            let mut slot = manager.server_slot(&key).unwrap_or_default();
            slot.endpoint = None;
            slot.activity = None;
            let mut permanent = error.permanent;
            let mut reason = error.reason;
            if error.after_deploy {
                slot.deploy_failures = slot.deploy_failures.saturating_add(1);
                // 部署退避：连续多次完整部署都等不到就绪（典型如 sshd 禁了
                // TCP 转发，ping 永远打不通），再重试只是热循环，缓存成
                // 不可用并提示人介入，直到重连或 clear_unavailable_servers。
                if let Some(backoff) = deploy_backoff_reason(slot.deploy_failures) {
                    permanent = true;
                    reason = backoff.to_string();
                }
            }
            // 瞬时失败也把原因留在 slot 上：阶段仍是探测、之后自动重试，
            // 但状态栏芯片能显示「原因：…」，不再是无解释的空转。确定性
            // 失败同样记录（展示上 unavailable_reason 优先）。
            slot.last_failure = Some(reason.clone());
            // 只有确定性失败才占住缓存，瞬时失败留空以便下次重试。
            slot.unavailable_reason = permanent.then_some(reason);
            manager.set_server_slot(&key, slot);
            publish_server_if_watched(app, manager, root);
            Ok(None)
        }
    }
}

/// daemon 降级冷却到点后的重试：拿部署门闩串行化并发探测，成功恢复
/// daemon 标记；失败把降级时间戳重置为现在，再等一个完整冷却期，
/// 避免后续每次操作都对着已知失败的 daemon 白白探测一轮。
async fn retry_downgraded_daemon(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    key: &str,
) {
    let Ok(gate) = manager.server_gate(key) else {
        return;
    };
    let _guard = gate.lock().await;
    let Some(mut slot) = manager.server_slot(key) else {
        return;
    };
    let daemon_missing = slot
        .endpoint
        .as_ref()
        .is_some_and(|endpoint| endpoint.daemon.is_none());
    if !daemon_missing || !daemon_downgrade_retry_ready(slot.daemon_downgraded_at, Instant::now()) {
        return;
    }
    // 降级重试也重新走「本地文件 + 用户私有安装路径 + 远端 sha256」校验。
    // 这里没有 None 回退分支，因此不可能重新解析到项目内二进制。
    let Some(remote_bin) = find_verified_installed_binary(manager, root).await else {
        slot.daemon_downgraded_at = Some(Instant::now());
        manager.set_server_slot(key, slot);
        return;
    };
    match ensure_remote_daemon(manager, connection_id, root, &remote_bin).await {
        Some(access) => {
            if let Some(endpoint) = slot.endpoint.as_mut() {
                endpoint.daemon = Some(access);
            }
            slot.daemon_downgraded_at = None;
            manager.set_server_slot(key, slot);
        }
        None => {
            slot.daemon_downgraded_at = Some(Instant::now());
            manager.set_server_slot(key, slot);
        }
    }
}

/// 降级重试时重新定位可信安装：本地二进制的 SHA-256 必须与用户私有版本
/// 目录中的远端文件一致。任一步失败都返回 `None`，调用方继续走 serve。
async fn find_verified_installed_binary(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Option<String> {
    let (arch, local_binary) = locate_local_server_binary_with(manager, root, false)
        .await
        .ok()?;
    let connection_id = parse_remote_uri(&root.uri).ok()?.connection_id;
    let sftp = manager.open_sftp(&connection_id).await.ok()?;
    let home = resolve_server_home(manager, root).await.ok()?;
    let install_dir = prepare_server_install_dir(manager, &sftp, root, &home)
        .await
        .ok()?;
    let windows = windows_native_path(&root.canonical_path).is_some();
    let remote_bin = format!("{install_dir}/{}", server_binary_file_name(windows, &arch));
    let local_sha256 = sha256_of_file_cached(&local_binary).await.ok()?;
    remote_binary_sha_matches(manager, root, &remote_bin, &local_sha256)
        .await
        .then_some(remote_bin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_slot_cache_tracks_ready_and_unavailable_states() {
        let manager = SshManager::new();
        let key = server_slot_key("c1", "/srv/app");
        // 还没有结论：调用方需要走发现/部署。
        assert!(cached_server_slot(&manager, &key).is_none());

        manager.set_server_slot(
            &key,
            ServerSlot {
                endpoint: Some(ServerEndpoint {
                    port: 4000,
                    token: "t".to_string(),
                    daemon: None,
                }),
                ..Default::default()
            },
        );
        assert_eq!(
            cached_server_slot(&manager, &key).map(|cached| cached.map(|endpoint| endpoint.port)),
            Some(Some(4000))
        );

        // 端点失联后清缓存：回到需要重新发现的空状态。
        manager.clear_server_endpoint(&key);
        assert!(cached_server_slot(&manager, &key).is_none());

        // 确定性不可用：快路径直接判定不可用，不再重复部署。
        manager.set_server_slot(
            &key,
            ServerSlot {
                unavailable_reason: Some("远端架构不支持（armv7l）".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(
            cached_server_slot(&manager, &key).map(|cached| cached.is_none()),
            Some(true)
        );
    }

    #[test]
    fn deploy_backoff_kicks_in_after_consecutive_failures() {
        // 前两次失败仍按瞬时处理，给网络抖动留重试空间。
        assert!(deploy_backoff_reason(0).is_none());
        assert!(deploy_backoff_reason(1).is_none());
        // 连续 2 次完整部署未就绪 → 缓存不可用并提示 AllowTcpForwarding / 重启。
        let reason = deploy_backoff_reason(SERVER_DEPLOY_BACKOFF_THRESHOLD).unwrap();
        assert!(reason.contains("AllowTcpForwarding"));
        assert!(deploy_backoff_reason(3).is_some());
    }

    #[test]
    fn deploy_error_flags_distinguish_permanent_and_deploy_stage() {
        let permanent = ServerDeployError::permanent("架构不支持");
        assert!(permanent.permanent);
        assert!(!permanent.after_deploy);
        let stage = ServerDeployError::deploy_stage("server 启动超时");
        assert!(!stage.permanent);
        assert!(stage.after_deploy);
        // 普通字符串错误保持瞬时且不计退避（如 SFTP 打开失败）。
        let transient = ServerDeployError::from("open sftp 失败".to_string());
        assert!(!transient.permanent && !transient.after_deploy);
    }

    #[test]
    fn self_check_detail_keeps_first_short_line_only() {
        let stderr =
            "未知子命令: self-check\n用法: qingcode-agent (--version | serve --root <目录>)\n";
        assert_eq!(
            self_check_failure_detail(stderr, 2),
            "未知子命令: self-check"
        );
    }

    #[test]
    fn self_check_detail_truncates_long_line_and_falls_back_to_exit_code() {
        let long = "x".repeat(80);
        let detail = self_check_failure_detail(&long, 126);
        assert_eq!(detail.chars().count(), 61);
        assert!(detail.ends_with('…'));
        assert_eq!(self_check_failure_detail("  \n \n", 126), "退出码 126");
        assert_eq!(self_check_failure_detail("", 1), "退出码 1");
    }

    #[test]
    fn project_server_gitignore_blocks_every_state_artifact() {
        assert_eq!(SERVER_STATE_GITIGNORE, b"*\n");
        assert!(gitignore_excludes_directory(b"# local\n*\n"));
        assert!(!gitignore_excludes_directory(b"server.json\nserve.log\n"));
        assert!(!gitignore_excludes_directory(&[0xff, b'\n']));
    }
}
