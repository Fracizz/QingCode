//! 远端 Git 命令：状态解析、暂存、提交、推拉、日志、分支、远端与文件内容。

use super::*;

pub(super) fn parse_git_branch_header(header: &str) -> (Option<String>, Option<String>, u32, u32) {
    let value = header.trim_start_matches("## ");
    if value.starts_with("No commits yet on ") {
        return (
            Some(value.trim_start_matches("No commits yet on ").to_string()),
            None,
            0,
            0,
        );
    }
    if value.starts_with("HEAD (no branch)") {
        return (Some("HEAD".to_string()), None, 0, 0);
    }
    let (head_part, counts) = value.split_once(" [").unwrap_or((value, ""));
    let (branch, upstream) = head_part
        .split_once("...")
        .map_or((head_part, None), |(branch, upstream)| {
            (branch, Some(upstream.to_string()))
        });
    let mut ahead = 0;
    let mut behind = 0;
    for item in counts.trim_end_matches(']').split(',') {
        let item = item.trim();
        if let Some(value) = item.strip_prefix("ahead ") {
            ahead = value.parse().unwrap_or(0);
        }
        if let Some(value) = item.strip_prefix("behind ") {
            behind = value.parse().unwrap_or(0);
        }
    }
    (Some(branch.to_string()), upstream, ahead, behind)
}

/// `git status --porcelain=v1 -z` 的解析结果；路径仍是「仓库根相对」。
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct RemoteGitStatusParse {
    pub(super) branch: Option<String>,
    pub(super) upstream: Option<String>,
    pub(super) ahead: u32,
    pub(super) behind: u32,
    pub(super) entries: Vec<(String, String)>,
}

/// 解析 `-z` 输出：分支头 + `XY<空格>PATH` 记录（R/C 后面紧跟原路径，需要跳过）。
/// 编辑器自身的临时产物在这里就被剔除，避免徽标随粘贴上传抖动。
pub(super) fn parse_remote_git_status(stdout: &str) -> RemoteGitStatusParse {
    let records = stdout.split('\0').collect::<Vec<_>>();
    let mut parsed = RemoteGitStatusParse::default();
    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.starts_with("## ") {
            let (branch, upstream, ahead, behind) = parse_git_branch_header(record);
            parsed.branch = branch;
            parsed.upstream = upstream;
            parsed.ahead = ahead;
            parsed.behind = behind;
            continue;
        }
        if record.len() < 4 {
            continue;
        }
        let status = record[..2].to_string();
        let relative = record[3..].to_string();
        if status.contains('R') || status.contains('C') {
            index += 1;
        }
        if crate::git_status::is_editor_artifact(&relative, &status) {
            continue;
        }
        parsed.entries.push((relative, status));
    }
    parsed
}

/// 项目根相对仓库根的路径前缀（如 `apps/web/`；项目根即仓库根时为空）。
///
/// 结果按项目缓存：`git status` 一个项目只探测一次，稳态不额外增加远程往返。
/// 探测失败时返回错误，而不是退回空前缀把子目录项目的路径挂错。
pub(super) async fn remote_git_prefix(manager: &SshManager, path: &str) -> Result<String, String> {
    let key = normalize_remote_uri(path);
    if let Some(cached) = manager.cached_git_prefix(&key) {
        return Ok(cached);
    }
    let output = remote_git_command(
        manager,
        path,
        vec!["rev-parse".to_string(), "--show-prefix".to_string()],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(format!(
            "读取远程 Git 项目前缀失败：{}",
            output.stderr.trim()
        ));
    }
    let mut prefix = output.stdout.trim().to_string();
    if !prefix.is_empty() && !prefix.ends_with('/') {
        prefix.push('/');
    }
    manager.remember_git_prefix(&key, &prefix);
    Ok(prefix)
}

/// 状态条目是否都落在 `prefix` 下；`-- .` 限定子树后，不满足说明缓存的前缀已过期。
pub(super) fn entries_share_prefix(entries: &[(String, String)], prefix: &str) -> bool {
    prefix.is_empty()
        || entries
            .iter()
            .all(|(relative, _)| relative.starts_with(prefix))
}

#[tauri::command]
pub async fn ssh_git_status(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitStatus, String> {
    let output = remote_git_command(
        &manager,
        &path,
        [
            "status",
            "--porcelain=v1",
            "--branch",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
            // 限定在项目子树内：否则仓库其它目录的改动也会算进项目徽标。
            "--",
            ".",
        ]
        .map(str::to_string)
        .to_vec(),
        false,
    )
    .await?;
    if output.exit_code != 0 {
        if output
            .stderr
            .to_ascii_lowercase()
            .contains("not a git repository")
        {
            return Ok(RemoteGitStatus {
                is_repository: false,
                branch: None,
                upstream: None,
                behind: 0,
                ahead: 0,
                last_fetch_at: None,
                last_pull_at: None,
                last_push_at: None,
                changes: Vec::new(),
            });
        }
        return Err(format!("读取远程 Git 状态失败：{}", output.stderr.trim()));
    }
    let parsed = parse_remote_git_status(&output.stdout);

    // porcelain 永远是「仓库根相对」；项目根是仓库子目录时要裁掉前缀，
    // 否则前端按 `项目根 + 相对路径` 拼出来的绝对路径是错的。
    let mut prefix = remote_git_prefix(&manager, &path).await?;
    if !entries_share_prefix(&parsed.entries, &prefix) {
        // 缓存的前缀过期（项目被移动 / 重新 init）：丢掉缓存，立刻重新探测一次。
        manager.forget_git_prefix(&normalize_remote_uri(&path));
        prefix = remote_git_prefix(&manager, &path).await?;
    }
    let changes = parsed
        .entries
        .into_iter()
        .filter_map(|(relative, status)| {
            crate::git_status::strip_git_prefix(&relative, &prefix)
                .map(|path| RemoteGitChange { path, status })
        })
        .collect::<Vec<_>>();
    Ok(RemoteGitStatus {
        is_repository: true,
        branch: parsed.branch,
        upstream: parsed.upstream,
        behind: parsed.behind,
        ahead: parsed.ahead,
        last_fetch_at: None,
        last_pull_at: None,
        last_push_at: None,
        changes,
    })
}

pub(super) fn remote_git_file(root_uri: &str, value: &str) -> Result<String, String> {
    let relative = if value.starts_with(SSH_URI_PREFIX) {
        let root = parse_remote_uri(root_uri)?;
        let file = parse_remote_uri(value)?;
        if root.connection_id != file.connection_id
            || !remote_path_is_within(&file.path, &root.path)
        {
            return Err("仅允许操作当前 SSH 项目内的 Git 文件".to_string());
        }
        remote_relative_path(&root.path, &file.path)
    } else {
        value.replace('\\', "/")
    };
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.split('/').any(|part| part == "..")
    {
        return Err("仅允许操作当前 SSH 项目内的 Git 文件".to_string());
    }
    Ok(relative)
}

pub(super) async fn remote_git_command(
    manager: &SshManager,
    path: &str,
    args: Vec<String>,
    require_trust: bool,
) -> Result<RemoteExecResult, String> {
    let parsed = parse_remote_uri(path)?;
    let timeout = remote_git_timeout(&args);
    if let Some(native_root) = windows_native_path(&parsed.path) {
        return manager
            .exec_windows_git(path, &native_root, &args, require_trust, timeout)
            .await;
    }
    let command = format!(
        "git -C {} {}",
        shell_quote(&parsed.path),
        args.iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    manager
        .exec_uri_with_timeout(path, &command, require_trust, timeout)
        .await
}

/// 走网络的 Git 子命令放宽时限，其余按普通命令处理。
pub(super) fn remote_git_timeout(args: &[String]) -> Duration {
    match args.first().map(String::as_str) {
        Some("fetch" | "pull" | "push" | "clone") => REMOTE_NETWORK_EXEC_TIMEOUT,
        _ => REMOTE_EXEC_TIMEOUT,
    }
}

#[tauri::command]
pub async fn ssh_git_stage(
    path: String,
    files: Vec<String>,
    all: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let mut args = vec!["add".to_string()];
    if all.unwrap_or(false) || files.is_empty() {
        args.push("--all".to_string());
    } else {
        args.push("--".to_string());
        for file in files {
            args.push(remote_git_file(&path, &file)?);
        }
    }
    let output = remote_git_command(&manager, &path, args, true).await?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(output.stderr)
    }
}

#[tauri::command]
pub async fn ssh_git_unstage(
    path: String,
    files: Vec<String>,
    all: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let mut args = vec!["reset".to_string(), "HEAD".to_string()];
    if !all.unwrap_or(false) && !files.is_empty() {
        args.push("--".to_string());
        for file in files {
            args.push(remote_git_file(&path, &file)?);
        }
    }
    let output = remote_git_command(&manager, &path, args, true).await?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(output.stderr)
    }
}

#[tauri::command]
pub async fn ssh_git_commit(
    path: String,
    message: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    let output = remote_git_command(
        &manager,
        &path,
        vec!["commit".to_string(), "-m".to_string(), message],
        true,
    )
    .await?;
    if output.exit_code == 0 {
        Ok(output.stdout.trim().to_string())
    } else {
        Err(output.stderr)
    }
}

pub(super) async fn remote_git_simple(
    manager: &SshManager,
    path: &str,
    args: Vec<String>,
) -> Result<String, String> {
    let output = remote_git_command(manager, path, args, true).await?;
    if output.exit_code == 0 {
        let summary = if output.stdout.trim().is_empty() {
            output.stderr.trim()
        } else {
            output.stdout.trim()
        };
        Ok(summary.to_string())
    } else {
        Err(output.stderr.trim().to_string())
    }
}

#[tauri::command]
pub async fn ssh_git_push(path: String, manager: State<'_, SshManager>) -> Result<String, String> {
    remote_git_simple(&manager, &path, vec!["push".to_string()]).await
}

#[tauri::command]
pub async fn ssh_git_fetch(path: String, manager: State<'_, SshManager>) -> Result<String, String> {
    remote_git_simple(
        &manager,
        &path,
        vec!["fetch".to_string(), "--prune".to_string()],
    )
    .await
}

#[tauri::command]
pub async fn ssh_git_pull(
    path: String,
    rebase: Option<bool>,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitPullResult, String> {
    let mut args = vec!["pull".to_string()];
    if rebase.unwrap_or(false) {
        args.push("--rebase".to_string());
    }
    let summary = remote_git_simple(&manager, &path, args).await?;
    let status = ssh_git_status(path.clone(), manager).await?;
    let conflict_paths = status
        .changes
        .iter()
        .filter(|change| {
            matches!(
                change.status.as_str(),
                "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD"
            )
        })
        .map(|change| change.path.clone())
        .collect::<Vec<_>>();
    Ok(RemoteGitPullResult {
        summary,
        has_conflicts: !conflict_paths.is_empty(),
        conflict_paths,
    })
}

pub(super) fn validate_branch_name(branch: &str) -> Result<&str, String> {
    let branch = branch.trim();
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.starts_with("refs/")
        || branch.starts_with("remotes/")
        || branch.contains("..")
        || branch.contains(['\\', '\0', ' '])
    {
        return Err("无效的分支名".to_string());
    }
    Ok(branch)
}

#[tauri::command]
pub async fn ssh_git_log(
    path: String,
    limit: Option<u32>,
    skip: Option<u32>,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteGitCommitInfo>, String> {
    let limit = limit.unwrap_or(40).clamp(1, 100) as usize;
    let skip = skip.unwrap_or(0).min(100_000) as usize;
    let fetch = limit.saturating_add(skip).min(100_000);
    let output = remote_git_command(
        &manager,
        &path,
        vec![
            "log".to_string(),
            format!("-n{fetch}"),
            "--format=%H%x00%h%x00%s%x00%an%x00%cI%x00%D".to_string(),
        ],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        let error = output.stderr.to_ascii_lowercase();
        if error.contains("does not have any commits")
            || error.contains("bad revision")
            || error.contains("unknown revision")
            || error.contains("尚无任何提交")
        {
            return Ok(Vec::new());
        }
        return Err(format!("读取远程提交记录失败：{}", output.stderr.trim()));
    }
    let commits = output
        .stdout
        .lines()
        .filter_map(|line| {
            let parts = line.split('\0').collect::<Vec<_>>();
            (parts.len() >= 5).then(|| RemoteGitCommitInfo {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                subject: parts[2].to_string(),
                author: parts[3].to_string(),
                date: parts[4].trim().to_string(),
                refs: parts.get(5).map_or("", |value| value.trim()).to_string(),
            })
        })
        .skip(skip)
        .take(limit)
        .collect();
    Ok(commits)
}

#[tauri::command]
pub async fn ssh_git_branch_list(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitBranchList, String> {
    let mut output = remote_git_command(
        &manager,
        &path,
        [
            "for-each-ref",
            crate::git::BRANCH_LIST_FORMAT,
            crate::git::BRANCH_LIST_SORT,
            "refs/heads",
            "refs/remotes",
        ]
        .map(str::to_string)
        .to_vec(),
        false,
    )
    .await?;
    if output.exit_code != 0 {
        // As before, a remote-ref failure may still return the local branches.
        output = remote_git_command(
            &manager,
            &path,
            [
                "for-each-ref",
                crate::git::BRANCH_LIST_FORMAT,
                crate::git::BRANCH_LIST_SORT,
                "refs/heads",
            ]
            .map(str::to_string)
            .to_vec(),
            false,
        )
        .await?;
        if output.exit_code != 0 {
            return Err(format!("读取本地分支失败：{}", output.stderr.trim()));
        }
    }
    let branches = crate::git::parse_branch_list(&output.stdout);
    Ok(RemoteGitBranchList {
        local: branches
            .local
            .into_iter()
            .map(|branch| RemoteGitBranchInfo {
                name: branch.name,
                current: branch.current,
                upstream: branch.upstream,
            })
            .collect(),
        remote: branches.remote,
    })
}

#[tauri::command]
pub async fn ssh_git_remotes(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteGitRemote>, String> {
    let output = remote_git_command(
        &manager,
        &path,
        vec!["remote".to_string(), "-v".to_string()],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(format!("读取远程地址失败：{}", output.stderr.trim()));
    }
    let mut order = Vec::new();
    let mut remotes: HashMap<String, RemoteGitRemote> = HashMap::new();
    for line in output.stdout.lines() {
        let Some((name, rest)) = line.trim().split_once(['\t', ' ']) else {
            continue;
        };
        let rest = rest.trim();
        let (url, kind) = rest.rfind(" (").map_or((rest, ""), |index| {
            (rest[..index].trim(), rest[index..].trim())
        });
        if name.is_empty() || url.is_empty() {
            continue;
        }
        if !remotes.contains_key(name) {
            order.push(name.to_string());
            remotes.insert(
                name.to_string(),
                RemoteGitRemote {
                    name: name.to_string(),
                    fetch_url: None,
                    push_urls: Vec::new(),
                },
            );
        }
        let remote = remotes.get_mut(name).expect("remote inserted");
        if kind.contains("fetch") {
            remote.fetch_url = Some(url.to_string());
        } else if kind.contains("push") && !remote.push_urls.iter().any(|item| item == url) {
            remote.push_urls.push(url.to_string());
        }
    }
    Ok(order
        .into_iter()
        .filter_map(|name| remotes.remove(&name))
        .collect())
}

#[tauri::command]
pub async fn ssh_git_switch(
    path: String,
    branch: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let branch = validate_branch_name(&branch)?.to_string();
    let remote_ref = format!("refs/remotes/{branch}");
    let local_ref = format!("refs/heads/{branch}");
    let remote = remote_git_command(
        &manager,
        &path,
        vec!["rev-parse".to_string(), "--verify".to_string(), remote_ref],
        true,
    )
    .await?;
    let local = remote_git_command(
        &manager,
        &path,
        vec!["rev-parse".to_string(), "--verify".to_string(), local_ref],
        true,
    )
    .await?;
    let args = if remote.exit_code == 0 && local.exit_code != 0 {
        vec!["switch".to_string(), "--track".to_string(), branch]
    } else {
        vec!["switch".to_string(), branch]
    };
    let output = remote_git_command(&manager, &path, args, true).await?;
    if output.exit_code == 0 {
        Ok(())
    } else {
        Err(format!("切换远程 Git 分支失败：{}", output.stderr.trim()))
    }
}

#[tauri::command]
pub async fn ssh_git_commit_files(
    path: String,
    rev: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<RemoteGitCommitFileChange>, String> {
    let rev = validate_commit_rev(&rev)?.to_string();
    let output = remote_git_command(
        &manager,
        &path,
        vec![
            "show".to_string(),
            "--name-status".to_string(),
            "--pretty=format:".to_string(),
            "--no-renames".to_string(),
            // 只列项目子树内的文件，路径相对项目根（与状态、Diff 的路径基准一致）。
            "--relative".to_string(),
            rev,
        ],
        false,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(format!("读取提交文件失败：{}", output.stderr.trim()));
    }
    Ok(output
        .stdout
        .lines()
        .filter_map(|line| {
            let (status, file) = line.split_once('\t')?;
            let status = status.chars().next()?.to_string();
            (!file.trim().is_empty()).then(|| RemoteGitCommitFileChange {
                status,
                path: file.trim().to_string(),
                previous_path: None,
            })
        })
        .collect())
}

pub(super) async fn remote_git_show(
    manager: &SshManager,
    path: &str,
    revision: &str,
    file: &str,
) -> Result<String, String> {
    // `<rev>:<path>` 默认按仓库根解析；`./` 让 Git 按 `-C` 所在的项目目录解析，
    // 项目是仓库子目录时也不用额外探测前缀。
    let spec = format!("{revision}:./{file}");
    let output = remote_git_command(
        manager,
        path,
        vec!["show".to_string(), "--textconv".to_string(), spec],
        false,
    )
    .await?;
    Ok(if output.exit_code == 0 {
        output.stdout
    } else {
        String::new()
    })
}

#[tauri::command]
pub async fn ssh_git_commit_file_contents(
    path: String,
    rev: String,
    file: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitFileContents, String> {
    let rev = validate_commit_rev(&rev)?.to_string();
    let file = remote_git_file(&path, &file)?;
    Ok(RemoteGitFileContents {
        original: remote_git_show(&manager, &path, &format!("{rev}^"), &file).await?,
        modified: remote_git_show(&manager, &path, &rev, &file).await?,
    })
}

#[tauri::command]
pub async fn ssh_git_file_contents(
    path: String,
    file: String,
    manager: State<'_, SshManager>,
) -> Result<RemoteGitFileContents, String> {
    let file = remote_git_file(&path, &file)?;
    let file_uri = join_remote_uri(&path, &file);
    let modified = match manager.sftp_for_uri(&file_uri, false).await {
        Ok((sftp, parsed, root)) => {
            ensure_existing_path_within(&sftp, &parsed.path, &root).await?;
            let metadata = sftp.metadata(parsed.path.clone()).await.ok();
            if metadata
                .as_ref()
                .is_some_and(|value| value.len() > MAX_DIFF_BYTES)
            {
                format!("… 文件过大，已跳过内容（最多 {MAX_DIFF_BYTES} bytes）\n")
            } else {
                match sftp.read(parsed.path).await {
                    Ok(bytes) => file_encoding::decode(&bytes, file_encoding::FileEncoding::Auto)
                        .unwrap_or_default(),
                    Err(_) => String::new(),
                }
            }
        }
        Err(_) => String::new(),
    };
    Ok(RemoteGitFileContents {
        original: remote_git_show(&manager, &path, "HEAD", &file).await?,
        modified,
    })
}

#[tauri::command]
pub async fn ssh_git_show_head_file(
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Option<String>, String> {
    let root = manager.root_for_uri(&path, false)?;
    let file = remote_git_file(&root.uri, &path)?;
    let content = remote_git_show(&manager, &root.uri, "HEAD", &file).await?;
    Ok((!content.is_empty()).then_some(content))
}

#[tauri::command]
pub async fn ssh_git_discard(
    path: String,
    files: Vec<String>,
    staged: bool,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    for file in files {
        let file = remote_git_file(&path, &file)?;
        let status_output = remote_git_command(
            &manager,
            &path,
            vec![
                "status".to_string(),
                "--porcelain=v1".to_string(),
                "--".to_string(),
                file.clone(),
            ],
            true,
        )
        .await?;
        let status = status_output.stdout.get(..2).unwrap_or_default();
        let args = if status == "??" {
            vec![
                "clean".to_string(),
                "-f".to_string(),
                "--".to_string(),
                file,
            ]
        } else if staged && status.starts_with('A') {
            let unstage = remote_git_command(
                &manager,
                &path,
                vec![
                    "rm".to_string(),
                    "-f".to_string(),
                    "--cached".to_string(),
                    "--".to_string(),
                    file.clone(),
                ],
                true,
            )
            .await?;
            if unstage.exit_code != 0 {
                return Err(format!("丢弃远程 Git 更改失败：{}", unstage.stderr.trim()));
            }
            vec![
                "clean".to_string(),
                "-f".to_string(),
                "--".to_string(),
                file,
            ]
        } else if staged {
            vec![
                "restore".to_string(),
                "--source=HEAD".to_string(),
                "--staged".to_string(),
                "--worktree".to_string(),
                "--".to_string(),
                file,
            ]
        } else {
            vec![
                "restore".to_string(),
                "--worktree".to_string(),
                "--".to_string(),
                file,
            ]
        };
        let output = remote_git_command(&manager, &path, args, true).await?;
        if output.exit_code != 0 {
            return Err(format!("丢弃远程 Git 更改失败：{}", output.stderr.trim()));
        }
    }
    Ok(())
}
