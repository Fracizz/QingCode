use super::*;

fn root(uri: &str, path: &str) -> RegisteredRoot {
    RegisteredRoot {
        uri: uri.into(),
        canonical_path: path.into(),
        trusted: true,
    }
}

#[test]
fn claude_trusted_dirs_only_accept_confirmed_projects() {
    let json = r#"{"projects":{"/a":{"hasTrustDialogAccepted":true},"/b":{"hasTrustDialogAccepted":false},"/c":{}}}"#;
    assert_eq!(claude_trusted_dirs(json).unwrap(), vec!["/a".to_string()]);
    assert!(claude_trusted_dirs("{}").unwrap().is_empty());
    assert!(claude_trusted_dirs("not json").is_err());
}

#[test]
fn codex_trusted_dirs_parse_literal_and_basic_keys() {
    let toml = r#"
model = "x"
[projects.'/home/u/a']
trust_level = "trusted"

[projects."D:\\code\\b"]
trust_level = 'trusted' # comment

[projects."/home/u/untrusted"]
trust_level = "untrusted"

[other]
trust_level = "trusted"
"#;
    assert_eq!(
        codex_trusted_dirs(toml),
        vec!["/home/u/a".to_string(), r"D:\code\b".to_string()]
    );
}

#[test]
fn codex_project_header_rejects_unknown_escapes() {
    assert_eq!(codex_project_header(r#"[projects."a\nb"]"#), None);
    assert_eq!(codex_project_header("[projects]"), None);
}

#[test]
fn claude_trust_is_inherited_but_codex_requires_exact_match() {
    let roots = [
        root("ssh://c/home/code/app", "/home/code/app"),
        root("ssh://c/home/codex", "/home/codex"),
    ];
    let trusted = vec!["/home/code/".to_string()];
    assert_eq!(
        match_roots(CliAgent::Claude, &trusted, &roots),
        vec!["ssh://c/home/code/app".to_string()]
    );
    assert!(match_roots(CliAgent::Codex, &trusted, &roots).is_empty());
    let exact = vec!["/home/code/app".to_string()];
    assert_eq!(
        match_roots(CliAgent::Codex, &exact, &roots),
        vec!["ssh://c/home/code/app".to_string()]
    );
}

#[test]
fn windows_paths_match_across_separators_case_and_verbatim_prefix() {
    let roots = [root("ssh://w/D:/Code/App", r"\\?\D:\Code\App")];
    for dir in ["d:/code/app", r"D:\code\app\", "/D:/CODE/app"] {
        assert_eq!(
            match_roots(CliAgent::Codex, &[dir.to_string()], &roots),
            vec!["ssh://w/D:/Code/App".to_string()],
            "{dir}"
        );
    }
    assert_eq!(
        match_roots(CliAgent::Claude, &["D:/".to_string()], &roots).len(),
        1
    );
}

#[test]
fn read_commands_use_fixed_cli_config_paths() {
    let (unix, windows) = CliAgent::Claude.read_commands();
    assert!(unix.contains("${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json"));
    assert!(windows.contains("'.claude.json'"));
    let (unix, windows) = CliAgent::Codex.read_commands();
    assert!(unix.contains("${CODEX_HOME:-$HOME/.codex}/config.toml"));
    assert!(windows.contains("'config.toml'"));
    assert!(CliAgent::parse("opencode").is_err());
}
