//! 部署编排：发现存活 server / 上传-校验-启动 / 等就绪，以及
//! (连接, 根) 粒度的 slot 缓存、幂等跳过与部署退避。

use super::daemon::{daemon_downgrade_retry_ready, ensure_remote_daemon};
use super::download::{locate_local_server_binary, locate_local_server_binary_with};
use super::install_cache;
use super::paths::{
    can_reuse_discovered_server, legacy_agent_state_path, legacy_project_agent_binary_path,
    legacy_project_server_binary_path, parse_server_state, project_server_dir_path,
    remote_roots_equivalent, server_binary_file_name, server_gitignore_path, server_install_dir,
    server_serve_log_path, server_state_path, windows_remote_path,
};
use super::scripts::{
    deploy_server_command, kill_processes_by_executable_command,
    prepare_private_server_dirs_command, remote_sha256_command, remote_sha256_matches,
    self_check_then_deploy_command, sha256_of_file_cached, windows_deploy_for,
    windows_prepare_server_dirs_script, windows_remote_sha256_script, windows_remove_for,
    windows_self_check_then_deploy_script, windows_stop_for, PREPARE_HOME_INVALID_EXIT,
    SELF_CHECK_FAILED_EXIT,
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

/// 发现/部署的分阶段计时：每个阶段结束时 `mark`，最终摘要写进 slot，
/// 详情面板展示，用来对照各步远端往返的真实耗时。
pub(super) struct StageTimer {
    started: Instant,
    last: Instant,
    stages: Vec<(&'static str, Duration)>,
}

impl StageTimer {
    pub(super) fn new() -> Self {
        let now = Instant::now();
        Self {
            started: now,
            last: now,
            stages: Vec::new(),
        }
    }

    pub(super) fn mark(&mut self, label: &'static str) {
        let now = Instant::now();
        self.stages.push((label, now - self.last));
        self.last = now;
    }

    pub(super) fn summary(&self) -> String {
        format_stage_timings(&self.stages, self.started.elapsed())
    }
}

/// 「状态目录 0.3s · 发现 1.2s · 合计 1.5s」。纯函数便于单测。
pub(super) fn format_stage_timings(stages: &[(&str, Duration)], total: Duration) -> String {
    stages
        .iter()
        .map(|(label, elapsed)| format!("{label} {:.1}s", elapsed.as_secs_f64()))
        .chain(std::iter::once(format!("合计 {:.1}s", total.as_secs_f64())))
        .collect::<Vec<_>>()
        .join(" · ")
}

/// 解析并准备用户私有安装位置（家目录, 安装目录）。同一连接内结果不变，
/// 缓存后重连、多项目、重新发现都不必再起两次远端 shell；部署失败或断开时
/// 缓存会被丢弃，下次重新创建并校验。
async fn resolve_install_location(
    manager: &SshManager,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    connection_id: &str,
) -> Result<(String, String), ServerDeployError> {
    if let Some(cached) = manager.cached_server_install(connection_id) {
        return Ok(cached);
    }
    // 跨应用重启的持久缓存：只省掉「读家目录 + 建目录」那次远端 shell，
    // 符号链接 / 家目录边界校验照做，且结果必须与缓存的安装目录逐字一致，
    // 否则丢弃条目走完整准备流程。命中时跳过了目录的 0700 收紧，二进制
    // 本身仍在自检前 chmod 700。
    let identity = persisted_install_identity(manager, connection_id);
    if let Some(key) = identity.as_deref() {
        if let Some((home, install_dir)) = install_cache::load(key, SERVER_VERSION) {
            match verify_server_install_dir(sftp, &home).await {
                Ok(resolved) if home != "/" && resolved == install_dir => {
                    manager.remember_server_install(connection_id, &home, &resolved);
                    return Ok((home, resolved));
                }
                _ => {
                    let _ = install_cache::remove(key);
                }
            }
        }
    }
    let home = prepare_server_home(manager, root).await?;
    let install_dir = verify_server_install_dir(sftp, &home).await?;
    manager.remember_server_install(connection_id, &home, &install_dir);
    if let Some(key) = identity.as_deref() {
        let _ = install_cache::store(key, SERVER_VERSION, &home, &install_dir);
    }
    Ok((home, install_dir))
}

/// 持久缓存的身份键：用户名、主机、端口与本次连接已校验通过的主机指纹
/// （握手时指纹不符会直接拒绝连接）。指纹变化即换键，旧条目自然失效。
fn persisted_install_identity(manager: &SshManager, connection_id: &str) -> Option<String> {
    let session = manager.session(connection_id).ok()?;
    let config = session.config.lock().ok()?;
    install_cache::identity_key(
        &config.username,
        &config.host,
        config.port,
        config.host_key_fingerprint.as_deref(),
    )
}

/// 部署失败时同时丢弃内存与持久缓存：安装目录可能已被远端删除或权限被改。
fn forget_install_location(manager: &SshManager, connection_id: &str) {
    if let Some(key) = persisted_install_identity(manager, connection_id) {
        let _ = install_cache::remove(&key);
    }
    manager.forget_server_install(connection_id);
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
///
/// 第二个返回值表示本轮是否已确认远端二进制摘要与本地一致：发现失败
/// （典型如远端重启后 serve 已退出）转入部署时据此跳过重复比对。
async fn try_discover_server(
    manager: &SshManager,
    connection_id: &str,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
    local_sha256: &str,
    remote_bin: &str,
) -> (Option<ServerEndpoint>, bool) {
    let state_path = server_state_path(&root.canonical_path);
    let state = match sftp.read(state_path).await {
        Ok(bytes) => parse_server_state(&bytes).ok(),
        // 状态文件不存在（或是目录）：没有可复用的 serve，摘要留给部署阶段比对。
        Err(_) => return (None, false),
    };
    let Some(state) = state else {
        return (None, false);
    };
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
        return (None, remote_matches);
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
    let alive = ping_server(manager, connection_id, &endpoint).await.is_ok();
    (alive.then_some(endpoint), remote_matches)
}

/// 一次远端往返完成「读家目录 + 创建用户私有版本目录」，再把家目录统一成
/// SFTP 路径。此前读家目录与建目录各起一次远端 shell，Windows 上每次都要
/// 冷启动 PowerShell（实测各 2~3 秒）。Windows 只接受盘符路径，UNC / 相对
/// 路径在脚本里就拒绝，避免把共享目录当成用户私有安装位置。
async fn prepare_server_home(
    manager: &SshManager,
    root: &RegisteredRoot,
) -> Result<String, ServerDeployError> {
    let windows = windows_native_path(&root.canonical_path).is_some();
    let result = exec_on_root(
        manager,
        root,
        &prepare_private_server_dirs_command(SERVER_VERSION),
        &windows_prepare_server_dirs_script(SERVER_VERSION),
    )
    .await
    .map_err(|error| {
        ServerDeployError::permanent(format!("准备用户私有 server 目录失败：{error}"))
    })?;
    if result.exit_code == PREPARE_HOME_INVALID_EXIT {
        return Err(ServerDeployError::permanent(if windows {
            "Windows 远端 USERPROFILE 不是受支持的盘符路径"
        } else {
            "远端家目录无效：必须是根目录以外的绝对路径"
        }));
    }
    if result.exit_code != 0 {
        return Err(ServerDeployError::permanent(format!(
            "创建或收紧用户私有 server 目录失败（退出码 {}）",
            result.exit_code
        )));
    }
    // PowerShell 可能在前面夹带空行，家目录是最后一个非空行。
    let raw = result
        .stdout
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or_default();
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

/// 验证 [`prepare_server_home`] 建好的 `~/.qingcode/server/<version>`：
/// canonicalize 后仍必须位于家目录内，拒绝通过符号链接把安装目录重定向到
/// 外部位置。两次 canonicalize 互不依赖，并发发出省一个 SFTP 往返。
async fn verify_server_install_dir(
    sftp: &SftpSession,
    home: &str,
) -> Result<String, ServerDeployError> {
    let install_dir = server_install_dir(home, SERVER_VERSION);
    let (resolved_home, resolved_install) = tokio::join!(
        sftp.canonicalize(home.to_string()),
        sftp.canonicalize(install_dir)
    );
    let resolved_home = resolved_home
        .map_err(|error| ServerDeployError::permanent(format!("远端家目录不可用：{error}")))?;
    let resolved_install = resolved_install
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
/// `sha_known_match` 为真表示本轮发现阶段刚比对过且一致，不再重算。
async fn upload_server_binary(
    manager: &SshManager,
    sftp: &SftpSession,
    root: &RegisteredRoot,
    local: &Path,
    target: &ServerInstallTarget<'_>,
    sha_known_match: bool,
) -> Result<bool, String> {
    if sha_known_match
        || remote_binary_sha_matches(manager, root, target.remote_bin, target.local_sha256).await
    {
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

/// 调用方必须已在不执行目标文件的前提下用远端 `sha256sum` / `Get-FileHash`
/// 比对过本地摘要；这里在同一次远端往返里 exec `self-check`（二进制自校验
/// 摘要并探测 noexec），自检通过才启动 serve。这样损坏、被替换或来源不明的
/// 文件永远不会进入执行阶段。自检失败按 permanent 处理，往返失败按部署
/// 阶段失败处理。此前 chmod、自检、启动各起一次远端 shell。
async fn self_check_and_start_server(
    manager: &SshManager,
    root: &RegisteredRoot,
    remote_bin: &str,
    local_sha256: &str,
) -> Result<(), ServerDeployError> {
    let state_path = server_state_path(&root.canonical_path);
    let serve_log = server_serve_log_path(&root.canonical_path);
    // 用户目录与文件都只允许当前用户访问；跳过上传的旧文件也可能权限被改动，
    // 组合命令开头先 chmod 700。
    let command = self_check_then_deploy_command(
        remote_bin,
        local_sha256,
        &deploy_server_command(remote_bin, &root.canonical_path, &state_path, &serve_log),
    );
    let windows_script = match windows_host_path(remote_bin) {
        Some(path) => windows_self_check_then_deploy_script(
            &path,
            local_sha256,
            &windows_deploy_for(remote_bin, &root.canonical_path, &state_path, &serve_log)
                .map_err(ServerDeployError::from)?,
        ),
        None => String::new(),
    };
    let result = manager
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
    if result.exit_code == SELF_CHECK_FAILED_EXIT {
        let detail = self_check_failure_detail(&result.stderr, result.exit_code);
        return Err(ServerDeployError::permanent(format!(
            "远端服务程序自检未通过（{detail}）：用户私有安装目录可能不允许执行，或文件在摘要校验后被替换。请重新连接以重新部署"
        )));
    }
    // 启动脚本本身的退出码不作结论：serve 是否可用由随后的就绪轮询判定。
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
        // 旧布局文件绝大多数时候早已不在：先用一次 SFTP 确认存在，再做进程清理。
        // 此前每次发现都无条件跑两轮远端进程枚举（Windows 上是 Win32_Process
        // 全量查询 + 300ms 等待），是重连变慢的主要来源。
        let exists = matches!(
            tokio::time::timeout(Duration::from_secs(2), sftp.metadata(binary.clone())).await,
            Ok(Ok(_))
        );
        if !exists {
            continue;
        }
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
        // 先查后睡：启动脚本返回时状态文件常常已经写好，不必白等一个轮询间隔。
        if let Ok(bytes) = sftp.read(state_path.clone()).await {
            // 版本或根不符（旧实例的残留状态）：等新进程覆盖，落到下面的 sleep。
            let state = parse_server_state(&bytes).ok().filter(|state| {
                state.version == SERVER_VERSION
                    && remote_roots_equivalent(
                        &state.root,
                        &root.canonical_path,
                        windows_native_path(&root.canonical_path).is_some(),
                    )
            });
            if let Some(state) = state {
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
        tokio::time::sleep(AGENT_READY_POLL).await;
    }
}

/// 部署退避决策：连续失败次数达到阈值后给出的不可用原因（None = 继续按瞬时
/// 处理）。抽成纯函数便于单测。
fn deploy_backoff_reason(failures: u32) -> Option<&'static str> {
    (failures >= SERVER_DEPLOY_BACKOFF_THRESHOLD).then_some(
        "连续多次部署后 server 仍未就绪：请检查远端 sshd 是否允许 TCP 转发（AllowTcpForwarding）、重启远端 server 进程，或断开重连后再试",
    )
}

/// 发现或部署远端 serve；不可用时返回原因，调用方回退直连。
///
/// 返回 serve 端点与已通过 SHA-256 校验的远端二进制路径。daemon 探测不在这里
/// 做：调用方先发布 serve 就绪，再在后台补探 daemon（见 [`spawn_daemon_probe`]），
/// 状态芯片与文件操作不必等 daemon 的启动、token 轮询与握手。
async fn discover_or_deploy_server(
    manager: &SshManager,
    connection_id: &str,
    root: &RegisteredRoot,
    app: Option<&tauri::AppHandle>,
    timer: &mut StageTimer,
) -> Result<(ServerEndpoint, String), ServerDeployError> {
    let sftp = manager.open_sftp(connection_id).await?;
    // 发现和启动 serve 都依赖这里的状态文件与日志目录；干净项目必须先创建
    // 并验证项目内目录，再进入 try_discover 或安装流程。
    ensure_project_server_state_dir(&sftp, root).await?;
    timer.mark("状态目录");
    // 先解析本地二进制（只查本地、不触发下载）。本地没有可信文件时不做
    // 发现，后续必须下载或由用户提供离线文件。
    let local_candidate = locate_local_server_binary_with(manager, root, false)
        .await
        .ok();
    let windows = windows_native_path(&root.canonical_path).is_some();

    // 发现阶段已确认远端摘要一致时，部署阶段跳过重复比对。
    let mut sha_known_match = false;
    if let Some((arch, local_binary)) = local_candidate.as_ref() {
        let (_, install_dir) =
            resolve_install_location(manager, &sftp, root, connection_id).await?;
        timer.mark("安装目录");
        let remote_bin = format!("{install_dir}/{}", server_binary_file_name(windows, arch));
        let local_sha256 = sha256_of_file_cached(local_binary)
            .await
            .map_err(ServerDeployError::from)?;
        let (discovered, remote_matches) = try_discover_server(
            manager,
            connection_id,
            &sftp,
            root,
            app,
            &local_sha256,
            &remote_bin,
        )
        .await;
        timer.mark("发现");
        if let Some(endpoint) = discovered {
            cleanup_legacy_project_install(manager, &sftp, root, arch).await;
            timer.mark("旧版清理");
            return Ok((endpoint, remote_bin));
        }
        sha_known_match = remote_matches;
    }

    let (arch, local_binary) = match local_candidate {
        Some(local) => local,
        None => locate_local_server_binary(manager, root).await?,
    };
    let (home, install_dir) = resolve_install_location(manager, &sftp, root, connection_id).await?;
    let remote_bin = format!("{install_dir}/{}", server_binary_file_name(windows, &arch));
    // 上传之前才标 installing；找本地二进制仍算 probing。
    server_status::note_server_activity(
        manager,
        app,
        root,
        connection_id,
        server_status::ServerPhase::Installing,
    );
    timer.mark("准备安装");
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
    let uploaded = upload_server_binary(
        manager,
        &sftp,
        root,
        &local_binary,
        &target,
        sha_known_match,
    )
    .await
    .map_err(ServerDeployError::deploy_stage)?;
    if uploaded {
        // 真正上传了新文件必须重新校验落盘结果（不执行目标文件）；跳过上传时
        // 摘要刚刚比对过，不必再算一遍。
        if !remote_binary_sha_matches(manager, root, &remote_bin, &local_sha256).await {
            return Err(ServerDeployError::permanent(
                "远端 server 二进制 SHA-256 与本地可信文件不一致，已拒绝执行",
            ));
        }
        timer.mark("上传");
    } else if !sha_known_match {
        timer.mark("比对(免上传)");
    }
    // 新版本摘要可信后才清理旧项目目录；清理过程不会执行旧二进制。放在启动
    // 之前，避免旧 serve 与新 serve 争用状态文件。
    cleanup_legacy_project_install(manager, &sftp, root, &arch).await;
    // 同一次远端往返里 self-check（同时探测 noexec）并启动 serve。
    self_check_and_start_server(manager, root, &remote_bin, &local_sha256).await?;
    timer.mark("自检+启动");
    // serve ping 之前进入握手。
    server_status::note_server_activity(
        manager,
        app,
        root,
        connection_id,
        server_status::ServerPhase::Handshaking,
    );
    let endpoint = wait_server_ready(manager, connection_id, &sftp, root)
        .await
        .ok_or_else(|| ServerDeployError::deploy_stage("server 启动超时".to_string()))?;
    timer.mark("等待就绪");
    Ok((endpoint, remote_bin))
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

/// Server 模式下等待发现/部署整体的上限；首次部署含下载、上传与启动。
const SERVER_MODE_DEPLOY_WAIT: Duration = Duration::from_secs(180);
/// 端点就绪后等待后台 daemon 探测结束的上限；须大于探测自身的 30 秒预算加上
/// 重新校验安装的耗时，否则强制重探的失败原因会被「等待超时」盖掉。
const SERVER_MODE_DAEMON_WAIT: Duration = Duration::from_secs(45);
const SERVER_MODE_DAEMON_POLL: Duration = Duration::from_millis(200);

/// Server 模式的错误前缀；前端据此在提示里给出「切到 SSH 模式」。
pub(crate) const SERVER_MODE_ERROR_PREFIX: &str = "Server 模式：";

pub(crate) fn server_mode_error(detail: impl std::fmt::Display) -> String {
    format!("{SERVER_MODE_ERROR_PREFIX}{detail}")
}

/// Server 模式专用：等进行中的发现/部署（及 `need_daemon` 时的 daemon 探测）
/// 完成后返回端点；不可用时返回带原因的错误。调用方不得据此回退直连。
pub(crate) async fn require_server_endpoint(
    app: &tauri::AppHandle,
    manager: &SshManager,
    root: &RegisteredRoot,
    need_daemon: bool,
) -> Result<ServerEndpoint, String> {
    match remote_uri_connection_id(&root.uri).and_then(|id| manager.connection_mode(id)) {
        Some(RemoteMode::Server) => {}
        Some(RemoteMode::Ssh) => return Err("该连接为 SSH 模式，不使用远端 server".to_string()),
        // 会话已被断开（或尚未经 ssh_connect 定下模式）：不能当成 SSH 模式。
        None => return Err("SSH 连接未建立".to_string()),
    }
    if !root.trusted {
        return Err(server_mode_error("项目未受信任，无法使用远端 server"));
    }
    let connection_id = parse_remote_uri(&root.uri)?.connection_id;
    let key = server_slot_key(&connection_id, &root.canonical_path);
    let ensured = tokio::time::timeout(
        SERVER_MODE_DEPLOY_WAIT,
        ensure_server_endpoint_inner(manager, root, Some(app), true),
    )
    .await
    .map_err(|_| server_mode_error("等待远端 server 部署超时"))??;
    let Some(endpoint) = ensured else {
        let slot = manager.server_slot(&key).unwrap_or_default();
        let reason = slot
            .unavailable_reason
            .or(slot.last_failure)
            .unwrap_or_else(|| "原因未知".to_string());
        return Err(server_mode_error(format!("远端 server 不可用：{reason}")));
    };
    if !need_daemon || endpoint.daemon.is_some() {
        return Ok(endpoint);
    }
    // serve 就绪后 daemon 在后台探测；终端与运行任务必须等它有结论。之前失败
    // 过（降级冷却中）也立即重探一轮：用户主动新建终端，不该被 5 分钟冷却挡住。
    spawn_daemon_probe(app, root, &key, None, true);
    let deadline = Instant::now() + SERVER_MODE_DAEMON_WAIT;
    loop {
        let slot = manager.server_slot(&key).unwrap_or_default();
        match slot.endpoint {
            Some(current) if current.daemon.is_some() => return Ok(current),
            Some(_) if slot.daemon_probe_pending && Instant::now() < deadline => {}
            Some(_) if slot.daemon_probe_pending => {
                return Err(server_mode_error("等待远端 daemon 就绪超时"));
            }
            Some(_) => {
                let detail = slot
                    .daemon_failure
                    .map(|reason| format!("：{reason}"))
                    .unwrap_or_default();
                return Err(server_mode_error(format!(
                    "远端 daemon 不可用{detail}（终端与运行任务需要 daemon），可在状态栏重启 server"
                )));
            }
            None => {
                let reason = slot
                    .last_failure
                    .unwrap_or_else(|| "端点已失效".to_string());
                return Err(server_mode_error(format!("远端 server 不可用：{reason}")));
            }
        }
        tokio::time::sleep(SERVER_MODE_DAEMON_POLL).await;
    }
}

/// slot 还没有结论（无端点、无不可用原因）且没有部署在跑时，后台补一轮
/// 发现/部署。状态查询与 server 调用失败后都走这里：否则 slot 停在「正在
/// 探测」却没有任何任务在推进，状态芯片会一直卡住。
pub(crate) fn kick_server_discovery(
    app: &tauri::AppHandle,
    manager: &SshManager,
    root: &RegisteredRoot,
) {
    if !manager.root_server_mode(root) || !root.trusted {
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
    // 未信任项目、SSH 模式连接：不部署，直接公布直连原因。Windows 远端走 serve。
    if !manager.server_mode(&connection_id) || !root.trusted {
        publish_server_if_watched(app, manager, root);
        return Ok(None);
    }
    if let Some(cached) = cached_server_slot(manager, &key) {
        // daemon 降级满冷却期后补一次探测：降级只清 daemon 标记，若不重试，
        // daemon 崩溃后这条连接永远回不去 daemon 传输，直到端点整体重建。
        // 有 AppHandle 时放到后台，不让本次操作陪着等 daemon 握手。
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
            match app {
                Some(app) => spawn_daemon_probe(app, root, &key, None, false),
                None => probe_daemon_for_slot(manager, root, &key, None, false).await,
            }
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
    let guard = gate.lock().await;
    if let Some(cached) = cached_server_slot(manager, &key) {
        manager.set_server_activity(&key, None);
        publish_server_if_watched(app, manager, root);
        return Ok(cached);
    }
    // 新一轮从 probing 开始，清掉上次中断留下的瞬时阶段。
    manager.set_server_activity(&key, None);
    publish_server_if_watched(app, manager, root);
    let mut timer = StageTimer::new();
    match discover_or_deploy_server(manager, &connection_id, root, app, &mut timer).await {
        Ok((endpoint, remote_bin)) => {
            let mut slot = manager.server_slot(&key).unwrap_or_default();
            slot.endpoint = Some(endpoint.clone());
            slot.unavailable_reason = None;
            slot.activity = None;
            slot.last_failure = None;
            // 部署成功：退避计数清零，下一次失败重新从 1 数起。
            slot.deploy_failures = 0;
            slot.daemon_downgraded_at = None;
            slot.daemon_failure = None;
            slot.last_timings = Some(timer.summary());
            manager.set_server_slot(&key, slot);
            // serve 已可用就先发布就绪；daemon 在后台探测，通过后再把传输升级为
            // daemon（watch 监督任务会察觉并切换）。
            publish_server_if_watched(app, manager, root);
            drop(guard);
            match app {
                Some(app) => spawn_daemon_probe(app, root, &key, Some(remote_bin), false),
                None => probe_daemon_for_slot(manager, root, &key, Some(remote_bin), false).await,
            }
            Ok(Some(endpoint))
        }
        Err(error) => {
            // 安装目录可能已被远端删除或权限被改：下次重新创建并校验。
            forget_install_location(manager, &connection_id);
            let mut slot = manager.server_slot(&key).unwrap_or_default();
            slot.endpoint = None;
            slot.activity = None;
            slot.last_timings = Some(timer.summary());
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

/// 在后台为已就绪的 serve 端点补探 daemon 传输，完成后发布新状态。
/// `daemon_probe_pending` 去重：发现成功与冷却重试不会同时各跑一轮。
/// `force` 跳过降级冷却（用户主动新建终端时）。
fn spawn_daemon_probe(
    app: &tauri::AppHandle,
    root: &RegisteredRoot,
    key: &str,
    remote_bin: Option<String>,
    force: bool,
) {
    let manager = app.state::<SshManager>();
    let Some(mut slot) = manager.server_slot(key) else {
        return;
    };
    // 已有 daemon 或探测进行中都不必再起一轮。
    if slot.daemon_probe_pending
        || slot
            .endpoint
            .as_ref()
            .is_some_and(|endpoint| endpoint.daemon.is_some())
    {
        return;
    }
    slot.daemon_probe_pending = true;
    manager.set_server_slot(key, slot);
    let app = app.clone();
    let root = root.clone();
    let key = key.to_string();
    tauri::async_runtime::spawn(async move {
        let manager = app.state::<SshManager>();
        probe_daemon_for_slot(&manager, &root, &key, remote_bin, force).await;
        server_status::publish_root_state(&app, &manager, &root);
    });
}

/// 为 slot 里的 serve 端点探测 daemon：拿部署门闩与重新部署互斥。端点在等锁或
/// 探测期间被替换、清掉，或刚有一次失败尚在冷却中，就放弃本轮、不写回结果。
/// 失败记下降级时间，冷却后由 ensure 快路径再试。
///
/// `remote_bin` 是本轮部署刚校验过的二进制；`None`（冷却重试）时重新走
/// 「本地文件 + 用户私有安装路径 + 远端 sha256」校验，不可能解析到项目内二进制。
/// `force` 时忽略降级冷却。
async fn probe_daemon_for_slot(
    manager: &SshManager,
    root: &RegisteredRoot,
    key: &str,
    remote_bin: Option<String>,
    force: bool,
) {
    let finish =
        |access: Result<DaemonAccess, String>, token: Option<&str>, elapsed: Option<Duration>| {
            let Some(mut slot) = manager.server_slot(key) else {
                return;
            };
            slot.daemon_probe_pending = false;
            let current = slot
                .endpoint
                .as_ref()
                .is_some_and(|endpoint| Some(endpoint.token.as_str()) == token);
            if current {
                slot.daemon_downgraded_at = access.is_err().then(Instant::now);
                slot.daemon_failure = access.as_ref().err().cloned();
                if let Some(endpoint) = slot.endpoint.as_mut() {
                    endpoint.daemon = access.ok();
                }
                if let Some(elapsed) = elapsed {
                    slot.last_timings = Some(append_stage_timing(
                        slot.last_timings.as_deref(),
                        "daemon",
                        elapsed,
                    ));
                }
            }
            manager.set_server_slot(key, slot);
        };
    let (Ok(parsed), Ok(gate)) = (parse_remote_uri(&root.uri), manager.server_gate(key)) else {
        finish(Err(String::new()), None, None);
        return;
    };
    let _guard = gate.lock().await;
    let Some(slot) = manager.server_slot(key) else {
        return;
    };
    let waiting_cooldown = !force
        && slot
            .daemon_downgraded_at
            .is_some_and(|at| !daemon_downgrade_retry_ready(Some(at), Instant::now()));
    let token = slot
        .endpoint
        .as_ref()
        .filter(|endpoint| endpoint.daemon.is_none())
        .map(|endpoint| endpoint.token.clone());
    let Some(token) = token.filter(|_| !waiting_cooldown) else {
        finish(Err(String::new()), None, None);
        return;
    };
    let started = Instant::now();
    let remote_bin = match remote_bin {
        Some(bin) => Some(bin),
        None => find_verified_installed_binary(manager, root).await,
    };
    let access = match remote_bin {
        Some(bin) => ensure_remote_daemon(manager, &parsed.connection_id, root, &bin).await,
        None => Err("未找到已校验的远端 server 二进制".to_string()),
    };
    finish(access, Some(&token), Some(started.elapsed()));
}

/// 把后台阶段（如 daemon 探测）追加到耗时摘要末尾并标注「后台」。摘要里的
/// 「合计」仍表示到 serve 就绪的等待时长，后台阶段不计入。
pub(super) fn append_stage_timing(
    existing: Option<&str>,
    label: &str,
    elapsed: Duration,
) -> String {
    let stage = format!("{label} {:.1}s（后台）", elapsed.as_secs_f64());
    match existing {
        Some(existing) if !existing.is_empty() => format!("{existing} · {stage}"),
        _ => stage,
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
    let (_, install_dir) = resolve_install_location(manager, &sftp, root, &connection_id)
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
    fn stage_timings_list_each_stage_then_total() {
        let text = format_stage_timings(
            &[
                ("状态目录", Duration::from_millis(340)),
                ("发现", Duration::from_millis(1260)),
            ],
            Duration::from_millis(1600),
        );
        assert_eq!(text, "状态目录 0.3s · 发现 1.3s · 合计 1.6s");
        assert_eq!(format_stage_timings(&[], Duration::ZERO), "合计 0.0s");
    }

    #[test]
    fn background_stage_is_appended_without_touching_total() {
        let base = "发现 1.3s · 合计 1.6s";
        assert_eq!(
            append_stage_timing(Some(base), "daemon", Duration::from_millis(2100)),
            "发现 1.3s · 合计 1.6s · daemon 2.1s（后台）"
        );
        assert_eq!(
            append_stage_timing(None, "daemon", Duration::from_millis(900)),
            "daemon 0.9s（后台）"
        );
    }

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
