use super::*;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_base(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("qingcode-git-{label}-{nonce}"))
}

fn git_success(root: &Path, args: &[&str]) {
    let output = run_git(root, args).expect("run git");
    assert!(output.status.success(), "{}", git_output_text(&output));
}

fn init_test_repo(label: &str) -> PathBuf {
    let root = temp_base(label);
    fs::create_dir_all(&root).unwrap();
    git_success(&root, &["init"]);
    git_success(&root, &["config", "user.email", "test@qingcode.local"]);
    git_success(&root, &["config", "user.name", "QingCode Test"]);
    root
}

#[test]
fn ensure_git_root_rejects_path_outside_allowlist() {
    let base = temp_base("outside");
    let project = base.join("project");
    let outside = base.join("outside");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&outside).unwrap();

    let allowlist = PathAllowlist::new();
    allowlist.sync_project_roots(vec![project.to_string_lossy().into_owned()]);
    let err = ensure_git_root(&outside.to_string_lossy(), &allowlist).unwrap_err();
    assert!(err.contains("未经授权") || err.contains("不在"), "{err}");

    fs::remove_dir_all(base).unwrap();
}

#[test]
fn ensure_git_root_allows_registered_project() {
    let base = temp_base("under");
    let project = base.join("project");
    fs::create_dir_all(&project).unwrap();

    let allowlist = PathAllowlist::new();
    allowlist.sync_project_roots(vec![project.to_string_lossy().into_owned()]);
    assert!(ensure_git_root(&project.to_string_lossy(), &allowlist).is_ok());

    fs::remove_dir_all(base).unwrap();
}

#[test]
fn parse_remote_v_returns_empty_for_blank_input() {
    assert!(parse_remote_v("").is_empty());
    assert!(parse_remote_v("\n\n").is_empty());
}

#[test]
fn parse_remote_v_keeps_multiple_remotes_and_push_urls() {
    let remotes = parse_remote_v(
        "origin\thttps://gitee.com/acme/app.git (fetch)\n\
             origin\thttps://gitee.com/acme/app.git (push)\n\
             origin\thttps://github.com/acme/app.git (push)\n\
             github\tgit@github.com:acme/app.git (fetch)\n\
             github\tgit@github.com:acme/app.git (push)\n",
    );
    assert_eq!(remotes.len(), 2);
    assert_eq!(remotes[0].name, "origin");
    assert_eq!(
        remotes[0].fetch_url.as_deref(),
        Some("https://gitee.com/acme/app.git")
    );
    assert_eq!(
        remotes[0].push_urls,
        vec![
            "https://gitee.com/acme/app.git".to_string(),
            "https://github.com/acme/app.git".to_string(),
        ]
    );
    assert_eq!(remotes[1].name, "github");
    assert_eq!(
        remotes[1].fetch_url.as_deref(),
        Some("git@github.com:acme/app.git")
    );
    assert_eq!(
        remotes[1].push_urls,
        vec!["git@github.com:acme/app.git".to_string()]
    );
}

#[test]
fn list_remotes_reads_configured_urls() {
    let root = init_test_repo("remotes");
    git_success(
        &root,
        &["remote", "add", "origin", "https://example.com/origin.git"],
    );
    git_success(
        &root,
        &[
            "remote",
            "set-url",
            "--add",
            "--push",
            "origin",
            "https://example.com/mirror.git",
        ],
    );
    let remotes = list_remotes(&root).expect("list remotes");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert_eq!(
        remotes[0].fetch_url.as_deref(),
        Some("https://example.com/origin.git")
    );
    // Adding a push URL replaces the implicit same-as-fetch push URL.
    assert_eq!(
        remotes[0].push_urls,
        vec!["https://example.com/mirror.git".to_string()]
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn parses_branch_and_changed_files() {
    let status =
        parse_status(b"## feature/test...origin/feature/test\0 M src/main.ts\0?? notes.txt\0");
    assert_eq!(status.branch.as_deref(), Some("feature/test"));
    assert_eq!(status.upstream.as_deref(), Some("origin/feature/test"));
    assert_eq!(status.ahead, 0);
    assert_eq!(status.behind, 0);
    assert_eq!(status.changes.len(), 2);
    assert_eq!(status.changes[0].status, " M");
    assert_eq!(status.changes[1].path, "notes.txt");
}

#[test]
fn parses_ahead_behind_on_branch_header() {
    let status = parse_status(b"## main...origin/main [ahead 9, behind 3]\0 M src/a.ts\0");
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.upstream.as_deref(), Some("origin/main"));
    assert_eq!(status.ahead, 9);
    assert_eq!(status.behind, 3);
}

#[test]
fn parses_expanded_untracked_nested_files() {
    // Output shape from `git status -z --untracked-files=all`.
    let status = parse_status(b"## main\0?? .qingcode/run.json\0?? nested/a.txt\0");
    assert_eq!(status.changes.len(), 2);
    assert_eq!(status.changes[0].path, ".qingcode/run.json");
    assert_eq!(status.changes[0].status, "??");
    assert_eq!(status.changes[1].path, "nested/a.txt");
}

#[test]
fn parses_repository_without_commits() {
    let status = parse_status(b"## No commits yet on main\0?? README.md\0");
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.changes[0].status, "??");
}

#[test]
fn parses_rename_destination_path() {
    let status = parse_status(b"## main\0R  new.ts\0old.ts\0");
    assert_eq!(status.changes[0].path, "new.ts");
    assert_eq!(status.changes[0].status, "R ");
}

#[test]
fn keeps_chinese_and_space_paths_unquoted() {
    let status = parse_status("## main\0?? src/中文 文件.ts\0".as_bytes());
    assert_eq!(status.changes[0].path, "src/中文 文件.ts");
}

#[test]
fn decodes_gbk_diff_content() {
    // "中文" in GBK
    assert_eq!(decode_git_text(&[0xD6, 0xD0, 0xCE, 0xC4]), "中文");
}

#[cfg(windows)]
#[test]
fn resolve_relative_rejects_parent_dir() {
    let root = Path::new(r#"D:\project"#);
    assert!(resolve_relative(root, "../outside.txt").is_err());
}

#[cfg(windows)]
#[test]
fn resolve_relative_normalizes_separators() {
    let root = Path::new(r#"D:\project"#);
    let relative = resolve_relative(root, r#"D:\project\src\App.tsx"#).unwrap();
    assert_eq!(relative, "src/App.tsx");
}

#[test]
fn stages_and_unstages_tracked_deleted_and_special_paths() {
    let root = init_test_repo("stage-unstage");
    fs::write(root.join("tracked.txt"), "v1\n").unwrap();
    fs::write(root.join("deleted.txt"), "delete me\n").unwrap();
    stage_files(&root, &["tracked.txt".into(), "deleted.txt".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();

    fs::write(root.join("tracked.txt"), "v2\n").unwrap();
    fs::remove_file(root.join("deleted.txt")).unwrap();
    fs::write(root.join("中文 文件.txt"), "hello\n").unwrap();
    fs::write(root.join("-draft.txt"), "draft\n").unwrap();
    let files = vec![
        "tracked.txt".into(),
        "deleted.txt".into(),
        "中文 文件.txt".into(),
        "-draft.txt".into(),
    ];
    stage_files(&root, &files).unwrap();

    let staged = collect_git_status(&root).unwrap();
    assert!(staged
        .changes
        .iter()
        .all(|change| { change.status == "M " || change.status == "D " || change.status == "A " }));

    unstage_files(&root, &files).unwrap();
    let unstaged = collect_git_status(&root).unwrap();
    assert!(unstaged
        .changes
        .iter()
        .any(|change| change.path == "tracked.txt" && change.status == " M"));
    assert!(unstaged
        .changes
        .iter()
        .any(|change| change.path == "deleted.txt" && change.status == " D"));
    assert!(unstaged
        .changes
        .iter()
        .any(|change| change.path == "中文 文件.txt" && change.status == "??"));
    assert!(unstaged
        .changes
        .iter()
        .any(|change| change.path == "-draft.txt" && change.status == "??"));
    assert!(root.join("中文 文件.txt").is_file());
    assert!(root.join("-draft.txt").is_file());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn discards_unstaged_tracked_and_untracked_files() {
    let root = init_test_repo("discard-unstaged");
    fs::write(root.join("tracked.txt"), "v1\n").unwrap();
    stage_files(&root, &["tracked.txt".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();

    fs::write(root.join("tracked.txt"), "v2\n").unwrap();
    fs::write(root.join("scratch.txt"), "temp\n").unwrap();
    discard_unstaged_files(&root, &["tracked.txt".into(), "scratch.txt".into()]).unwrap();

    assert_eq!(
        fs::read_to_string(root.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "v1\n"
    );
    assert!(!root.join("scratch.txt").exists());
    let status = collect_git_status(&root).unwrap();
    assert!(status.changes.is_empty());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn discards_staged_changes_to_head() {
    let root = init_test_repo("discard-staged");
    fs::write(root.join("tracked.txt"), "v1\n").unwrap();
    stage_files(&root, &["tracked.txt".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();

    fs::write(root.join("tracked.txt"), "v2\n").unwrap();
    stage_files(&root, &["tracked.txt".into()]).unwrap();
    discard_staged_files(&root, &["tracked.txt".into()]).unwrap();

    assert_eq!(
        fs::read_to_string(root.join("tracked.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "v1\n"
    );
    let status = collect_git_status(&root).unwrap();
    assert!(status.changes.is_empty());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unborn_repo_can_unstage_without_changing_worktree() {
    let root = init_test_repo("unborn-unstage");
    fs::write(root.join("README.md"), "hello\n").unwrap();
    let files = vec!["README.md".into()];
    stage_files(&root, &files).unwrap();
    assert!(collect_git_status(&root)
        .unwrap()
        .changes
        .iter()
        .any(|change| change.status == "A "));

    unstage_files(&root, &files).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("README.md")).unwrap(),
        "hello\n"
    );
    assert!(collect_git_status(&root)
        .unwrap()
        .changes
        .iter()
        .any(|change| change.status == "??"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stage_all_and_unstage_all_cover_bulk_scm_actions() {
    let root = init_test_repo("bulk-all");
    fs::write(root.join("a.txt"), "a\n").unwrap();
    fs::write(root.join("b.txt"), "b\n").unwrap();
    stage_all(&root).unwrap();
    let staged = collect_git_status(&root).unwrap();
    assert!(staged
        .changes
        .iter()
        .all(|change| change.status.ends_with(' ')));
    unstage_all(&root).unwrap();
    let unstaged = collect_git_status(&root).unwrap();
    assert_eq!(unstaged.changes.len(), 2);
    assert!(unstaged.changes.iter().all(|change| change.status == "??"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn commit_includes_only_staged_version() {
    let root = init_test_repo("commit-staged");
    fs::write(root.join("a.txt"), "a1\n").unwrap();
    fs::write(root.join("b.txt"), "b1\n").unwrap();
    stage_files(&root, &["a.txt".into(), "b.txt".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();

    fs::write(root.join("a.txt"), "a2 staged\n").unwrap();
    fs::write(root.join("b.txt"), "b2 unstaged\n").unwrap();
    stage_files(&root, &["a.txt".into()]).unwrap();
    commit_staged(&root, "only a").unwrap();

    assert_eq!(git_show_revision(&root, "HEAD", "a.txt"), "a2 staged\n");
    assert_eq!(git_show_revision(&root, "HEAD", "b.txt"), "b1\n");
    let status = collect_git_status(&root).unwrap();
    assert!(status
        .changes
        .iter()
        .any(|change| change.path == "b.txt" && change.status == " M"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejects_empty_commit_message_and_unsafe_file_lists() {
    let root = init_test_repo("reject-input");
    assert_eq!(commit_staged(&root, "   ").unwrap_err(), "提交信息不能为空");
    assert!(resolve_files(&root, vec![]).is_err());
    assert!(resolve_files(&root, vec!["../outside.txt".into()]).is_err());
    assert!(resolve_files(&root, vec!["".into()]).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn pushes_current_branch_to_configured_upstream() {
    let root = init_test_repo("push-current");
    let remote = temp_base("push-remote");
    fs::create_dir_all(&remote).unwrap();
    git_success(&remote, &["init", "--bare"]);

    fs::write(root.join("README.md"), "v1\n").unwrap();
    stage_files(&root, &["README.md".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();
    let remote_path = remote.to_string_lossy().to_string();
    git_success(&root, &["remote", "add", "origin", &remote_path]);
    let branch_output = run_git(&root, &["branch", "--show-current"]).unwrap();
    let branch = decode_git_text(&branch_output.stdout).trim().to_string();
    assert!(!branch.is_empty());
    git_success(&root, &["push", "--set-upstream", "origin", &branch]);

    fs::write(root.join("README.md"), "v2\n").unwrap();
    stage_files(&root, &["README.md".into()]).unwrap();
    commit_staged(&root, "update").unwrap();
    push_current(&root).unwrap();

    let local_head = run_git(&root, &["rev-parse", "HEAD"]).unwrap();
    let remote_ref = format!("refs/heads/{branch}");
    let remote_head = run_git(&root, &["ls-remote", "origin", &remote_ref]).unwrap();
    let local_sha = decode_git_text(&local_head.stdout).trim().to_string();
    let remote_sha = decode_git_text(&remote_head.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string();
    assert_eq!(remote_sha, local_sha);

    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(remote).unwrap();
}

#[test]
fn push_without_remote_returns_git_error() {
    let root = init_test_repo("push-no-remote");
    fs::write(root.join("README.md"), "local only\n").unwrap();
    stage_files(&root, &["README.md".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();

    let error = push_current(&root).unwrap_err();
    assert!(error.starts_with("Git 推送失败："), "{error}");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn fetches_remote_tracking_branches_without_touching_worktree() {
    let root = init_test_repo("fetch-remote");
    let remote = temp_base("fetch-remote-bare");
    fs::create_dir_all(&remote).unwrap();
    git_success(&remote, &["init", "--bare"]);

    fs::write(root.join("README.md"), "v1\n").unwrap();
    stage_files(&root, &["README.md".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();
    let remote_path = remote.to_string_lossy().to_string();
    git_success(&root, &["remote", "add", "origin", &remote_path]);
    let branch = decode_git_text(
        &run_git(&root, &["branch", "--show-current"])
            .unwrap()
            .stdout,
    )
    .trim()
    .to_string();
    git_success(&root, &["push", "--set-upstream", "origin", &branch]);

    let other = temp_base("fetch-remote-other");
    let other_path = other.to_string_lossy().to_string();
    git_success(Path::new("."), &["clone", &remote_path, &other_path]);
    // Clones do not inherit the source repo's local user.* config; CI runners
    // often have no global identity, so configure before committing.
    git_success(&other, &["config", "user.email", "test@qingcode.local"]);
    git_success(&other, &["config", "user.name", "QingCode Test"]);
    git_success(&other, &["checkout", "-b", "feature/remote-only"]);
    fs::write(other.join("remote.txt"), "remote\n").unwrap();
    git_success(&other, &["add", "remote.txt"]);
    git_success(&other, &["commit", "-m", "remote branch"]);
    git_success(&other, &["push", "-u", "origin", "feature/remote-only"]);

    fetch_remote(&root).unwrap();
    let branches = list_branches(&root).unwrap();
    assert!(branches
        .remote
        .iter()
        .any(|name| name == "origin/feature/remote-only"));
    assert_eq!(
        fs::read_to_string(root.join("README.md"))
            .unwrap()
            .replace("\r\n", "\n"),
        "v1\n"
    );

    switch_branch(&root, "origin/feature/remote-only").unwrap();
    let after = list_branches(&root).unwrap();
    let current = after.local.iter().find(|b| b.current).unwrap();
    assert_eq!(current.name, "feature/remote-only");
    assert_eq!(
        fs::read_to_string(root.join("remote.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "remote\n"
    );

    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(remote).unwrap();
    fs::remove_dir_all(other).unwrap();
}

#[test]
fn lists_and_switches_local_branches() {
    let root = init_test_repo("branch-switch");
    fs::write(root.join("README.md"), "v1\n").unwrap();
    stage_files(&root, &["README.md".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();
    git_success(&root, &["branch", "feature/demo"]);

    let listed = list_branches(&root).unwrap();
    assert!(listed.local.iter().any(|b| b.current));
    assert!(listed.local.iter().any(|b| b.name == "feature/demo"));

    switch_branch(&root, "feature/demo").unwrap();
    let after = list_branches(&root).unwrap();
    let current = after.local.iter().find(|b| b.current).unwrap();
    assert_eq!(current.name, "feature/demo");

    assert!(validate_local_branch_name("-bad").is_err());
    assert!(validate_local_branch_name("../x").is_err());
    assert!(validate_local_branch_name("feature/demo").is_ok());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn branch_query_orders_local_and_remote_by_latest_commit_without_truncating() {
    let root = init_test_repo("branch-recency");
    for (name, date) in [
        ("a-old", "2020-01-01T00:00:00+00:00"),
        ("z-new", "2022-01-01T00:00:00+00:00"),
        ("m-middle", "2021-01-01T00:00:00+00:00"),
    ] {
        let output = Command::new("git")
            .current_dir(&root)
            .env("GIT_COMMITTER_DATE", date)
            .env("GIT_AUTHOR_DATE", date)
            .args([
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                name,
            ])
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", git_output_text(&output));
        git_success(&root, &["branch", name]);
        git_success(
            &root,
            &["update-ref", &format!("refs/remotes/origin/{name}"), "HEAD"],
        );
    }
    // Enough branches to exceed the menu's ten-branch viewport.
    for index in 0..15 {
        git_success(&root, &["branch", &format!("extra-{index:02}"), "a-old"]);
    }
    let result = list_branches(&root).unwrap();
    let selected: Vec<_> = result
        .local
        .iter()
        .filter(|branch| matches!(branch.name.as_str(), "a-old" | "z-new" | "m-middle"))
        .map(|branch| branch.name.as_str())
        .collect();
    assert_eq!(selected, ["z-new", "m-middle", "a-old"]);
    assert_eq!(result.local.len(), 19);
    assert_eq!(
        result.remote,
        ["origin/z-new", "origin/m-middle", "origin/a-old"]
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn combined_branch_query_matches_git_names_sorting_and_tracking() {
    let root = init_test_repo("combined-branches");
    fs::write(root.join("a.txt"), "initial\n").unwrap();
    stage_files(&root, &["a.txt".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();
    for name in ["feature/demo", "origin/topic", "local/HEAD", "功能/中文"] {
        git_success(&root, &["branch", name]);
    }
    // Disambiguated short names must match Git, even with overlapping namespaces.
    git_success(&root, &["tag", "feature/demo"]);
    git_success(&root, &["update-ref", "refs/remotes/origin/topic", "HEAD"]);
    git_success(
        &root,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/topic",
        ],
    );
    git_success(
        &root,
        &["remote", "add", "origin", "https://example.invalid/repo"],
    );
    git_success(
        &root,
        &["branch", "--set-upstream-to=refs/remotes/origin/topic"],
    );

    let legacy_local = run_git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)",
            "refs/heads",
        ],
    )
    .unwrap();
    let expected_local: Vec<_> = decode_git_text(&legacy_local.stdout)
        .lines()
        .map(str::to_string)
        .collect();
    let legacy_remote = run_git(
        &root,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
    )
    .unwrap();
    let expected_remote: Vec<_> = decode_git_text(&legacy_remote.stdout)
        .lines()
        .filter(|name| !name.ends_with("/HEAD"))
        .map(str::to_string)
        .collect();
    let result = list_branches(&root).unwrap();
    let actual_local: Vec<_> = result
        .local
        .iter()
        .map(|branch| {
            format!(
                "{}\t{}\t{}",
                branch.name,
                if branch.current { "*" } else { " " },
                branch.upstream.as_deref().unwrap_or("")
            )
        })
        .collect();
    assert_eq!(actual_local, expected_local);
    assert_eq!(result.remote, expected_remote);
    assert!(result
        .local
        .iter()
        .any(|branch| branch.name == "local/HEAD"));
    assert_eq!(
        result.local.iter().filter(|branch| branch.current).count(),
        1
    );

    git_success(&root, &["checkout", "--detach", "HEAD"]);
    assert!(list_branches(&root)
        .unwrap()
        .local
        .iter()
        .all(|branch| !branch.current));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn branch_query_handles_unborn_and_nested_worktree_roots() {
    let root = init_test_repo("branch-worktree");
    assert!(list_branches(&root).unwrap().local.is_empty());
    fs::write(root.join("a.txt"), "initial\n").unwrap();
    stage_files(&root, &["a.txt".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();
    let linked = temp_base("branch-worktree-linked");
    git_success(
        &root,
        &["worktree", "add", "-b", "linked", &linked.to_string_lossy()],
    );
    let nested = linked.join("nested");
    fs::create_dir(&nested).unwrap();
    let branches = list_branches(&nested).unwrap();
    assert_eq!(
        branches
            .local
            .iter()
            .find(|branch| branch.current)
            .unwrap()
            .name,
        "linked"
    );
    git_success(&root, &["worktree", "remove", &linked.to_string_lossy()]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn lists_recent_commits_in_order() {
    let root = init_test_repo("commit-log");
    fs::write(root.join("a.txt"), "1\n").unwrap();
    stage_files(&root, &["a.txt".into()]).unwrap();
    commit_staged(&root, "first").unwrap();
    fs::write(root.join("a.txt"), "2\n").unwrap();
    stage_files(&root, &["a.txt".into()]).unwrap();
    commit_staged(&root, "second").unwrap();

    let commits = list_commits(&root, 50, 0).unwrap();
    assert!(commits.len() >= 2);
    assert_eq!(commits[0].subject, "second");
    assert_eq!(commits[1].subject, "first");
    assert!(!commits[0].short_hash.is_empty());
    assert!(!commits[0].hash.is_empty());
    assert!(!commits[0].author.is_empty());
    assert!(!commits[0].date.is_empty());
    assert!(
        commits[0].refs.contains("HEAD"),
        "expected HEAD decoration, got {:?}",
        commits[0].refs
    );

    let page = list_commits(&root, 1, 1).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].subject, "first");

    let empty = init_test_repo("commit-log-empty");
    assert!(list_commits(&empty, 20, 0).unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(empty).unwrap();
}

#[test]
fn reflog_timestamp_reads_action_and_message() {
    let head = concat!(
        "1111111 HEAD@{1700000000}: clone: from https://example.com/repo.git
",
        "2222222 HEAD@{1700000500}: pull origin main: Fast-forward
",
    );
    assert_eq!(
        reflog_timestamp(head, PULL_REFLOG_NEEDLES),
        Some(1_700_000_500_000)
    );
    assert_eq!(reflog_timestamp(head, &["rebase "]), None);

    // 推送只出现在远程跟踪分支的 reflog 里，且没有说明段。
    let upstream = concat!(
        "3333333 refs/remotes/origin/main@{1700000900}: update by push
",
        "2222222 refs/remotes/origin/main@{1700000400}: fetch: fast-forward
",
    );
    assert_eq!(
        reflog_timestamp(upstream, PUSH_REFLOG_NEEDLES),
        Some(1_700_000_900_000)
    );
    // 时间戳不是数字（--date 非 unix）时跳过该行而不是 panic。
    assert_eq!(
        reflog_timestamp(
            "4444444 HEAD@{yesterday}: pull origin main
",
            PULL_REFLOG_NEEDLES
        ),
        None
    );
}

#[test]
fn sync_times_report_last_push_from_upstream_reflog() {
    let base = temp_base("push-time");
    let remote = base.join("remote.git");
    fs::create_dir_all(&remote).unwrap();
    git_success(&remote, &["init", "--bare"]);
    let root = base.join("work");
    fs::create_dir_all(&root).unwrap();
    git_success(&root, &["init"]);
    git_success(&root, &["config", "user.email", "test@qingcode.local"]);
    git_success(&root, &["config", "user.name", "QingCode Test"]);
    git_success(&root, &["commit", "--allow-empty", "-m", "init"]);
    git_success(
        &root,
        &["remote", "add", "origin", &remote.to_string_lossy()],
    );

    let status = collect_git_status_with_sync(&root).unwrap();
    assert_eq!(status.last_push_at, None);

    git_success(&root, &["push", "-u", "origin", "HEAD"]);
    let status = collect_git_status_with_sync(&root).unwrap();
    assert!(status.upstream.is_some(), "{status:?}");
    assert!(status.last_push_at.is_some(), "{status:?}");

    let _ = fs::remove_dir_all(base);
}

#[test]
fn lists_files_changed_in_a_commit() {
    let root = init_test_repo("commit-files");
    fs::write(root.join("a.txt"), "1\n").unwrap();
    fs::write(root.join("b.txt"), "b\n").unwrap();
    stage_files(&root, &["a.txt".into(), "b.txt".into()]).unwrap();
    commit_staged(&root, "initial").unwrap();
    fs::write(root.join("a.txt"), "2\n").unwrap();
    fs::write(root.join("c.txt"), "c\n").unwrap();
    stage_files(&root, &["a.txt".into(), "c.txt".into()]).unwrap();
    commit_staged(&root, "update").unwrap();

    let head = list_commits(&root, 1, 0).unwrap();
    assert_eq!(head[0].subject, "update");
    let files = list_commit_files(&root, &head[0].hash).unwrap();
    assert!(files.iter().any(|f| f.path == "a.txt" && f.status == "M"));
    assert!(files.iter().any(|f| f.path == "c.txt" && f.status == "A"));

    let pair = commit_file_contents(&root, &head[0].hash, "a.txt").unwrap();
    assert_eq!(pair.original, "1\n");
    assert_eq!(pair.modified, "2\n");

    fs::remove_dir_all(root).unwrap();
}
