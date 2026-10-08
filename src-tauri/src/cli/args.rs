//! Minimal argv parser for `qingcode.exe` subcommands.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    SettingsReset {
        scope: String,
        project: Option<String>,
    },
    SettingsExport {
        scope: String,
        project: Option<String>,
        output: Option<String>,
    },
    SettingsImport {
        scope: String,
        project: Option<String>,
        json_source: String,
    },
    ProjectList,
    ProjectAdd {
        paths: Vec<String>,
    },
    ProjectRemove {
        query: String,
    },
    ProjectSwitch {
        query: String,
    },
    RunList {
        project: Option<String>,
    },
    RunGet {
        query: String,
        project: Option<String>,
    },
    RunUpsert {
        json_source: String,
        project: Option<String>,
    },
    RunRemove {
        query: String,
        project: Option<String>,
    },
    RunStart {
        query: String,
        project: Option<String>,
    },
    RunStop {
        query: String,
        project: Option<String>,
    },
    RunStatus {
        project: Option<String>,
    },
    TrustGrant {
        path: String,
    },
    Open {
        targets: Vec<String>,
    },
}

const ROOT_COMMANDS: &[&str] = &["project", "run", "settings", "trust", "open", "help"];

/// Returns `Some` when argv is a CLI invocation (not plain GUI / open-with files).
pub fn parse(args: &[String]) -> Option<Result<Command, String>> {
    let rest: Vec<&str> = args.iter().skip(1).map(String::as_str).collect();
    if rest.is_empty() {
        return None;
    }
    let first = rest[0];
    if first == "-h" || first == "--help" || first == "help" {
        return Some(Ok(Command::Help));
    }
    if !ROOT_COMMANDS.contains(&first) {
        return None;
    }
    Some(parse_command(&rest))
}

fn parse_command(rest: &[&str]) -> Result<Command, String> {
    match rest[0] {
        "help" => Ok(Command::Help),
        "project" => parse_project(&rest[1..]),
        "run" => parse_run(&rest[1..]),
        "settings" => parse_settings(&rest[1..]),
        "trust" => parse_trust(&rest[1..]),
        "open" => {
            let targets: Vec<String> = rest[1..]
                .iter()
                .filter(|a| !a.starts_with('-'))
                .map(|s| (*s).to_string())
                .collect();
            if targets.is_empty() {
                Err("usage: open <file>[:line[:col]] ...".into())
            } else {
                Ok(Command::Open { targets })
            }
        }
        other => Err(format!("unknown command: {other}")),
    }
}

fn parse_settings(args: &[&str]) -> Result<Command, String> {
    if args.contains(&"--help") || args.contains(&"-h") {
        return Ok(Command::Help);
    }
    let Some(sub) = args.first().copied() else {
        return Err(
            "usage: settings <export|import|reset> [--scope user|workspace] [--project ...]".into(),
        );
    };
    let mut scope = "user".to_string();
    let mut project = None;
    let mut output = None;
    let mut json_source = None;
    let mut seen = std::collections::HashSet::new();
    let mut confirmed = false;
    let mut i = 1;
    while i < args.len() {
        let flag = args[i];
        if flag == "--yes" {
            if !seen.insert(flag) {
                return Err("duplicate settings option: --yes".into());
            }
            confirmed = true;
            i += 1;
            continue;
        }
        if !["--scope", "--project", "--output", "--json"].contains(&flag) || !seen.insert(flag) {
            return Err(format!("unknown or duplicate settings option: {flag}"));
        }
        let value = args
            .get(i + 1)
            .filter(|v| !v.starts_with('-') || **v == "-")
            .ok_or_else(|| format!("missing value for {flag}"))?
            .to_string();
        match flag {
            "--scope" => scope = value,
            "--project" => project = Some(value),
            "--output" => output = Some(value),
            "--json" => json_source = Some(value),
            _ => unreachable!(),
        }
        i += 2;
    }
    if !["user", "workspace"].contains(&scope.as_str()) || (scope == "user" && project.is_some()) {
        return Err("use --scope user, or --scope workspace [--project <id|path|name>]".into());
    }
    match sub {
        "export" if json_source.is_none() && !confirmed => Ok(Command::SettingsExport {
            scope,
            project,
            output,
        }),
        "import" if output.is_none() && !confirmed => Ok(Command::SettingsImport {
            scope,
            project,
            json_source: json_source
                .ok_or_else(|| "usage: settings import --json <file|->".to_string())?,
        }),
        "reset" if confirmed && output.is_none() && json_source.is_none() => Ok(Command::SettingsReset { scope, project }),
        _ => {
            Err("usage: settings export [--output <file>] | settings import --json <file|-> | settings reset --yes".into())
        }
    }
}

fn parse_project(args: &[&str]) -> Result<Command, String> {
    let Some(sub) = args.first().copied() else {
        return Err("usage: project <list|add|remove|switch> ...".into());
    };
    match sub {
        "list" => Ok(Command::ProjectList),
        "add" => {
            let paths: Vec<String> = args[1..]
                .iter()
                .filter(|a| !a.starts_with('-'))
                .map(|s| (*s).to_string())
                .collect();
            if paths.is_empty() {
                Err("usage: project add <dir> [<dir>...]".into())
            } else {
                Ok(Command::ProjectAdd { paths })
            }
        }
        "remove" | "rm" => {
            let query = args
                .get(1)
                .filter(|a| !a.starts_with('-'))
                .map(|s| (*s).to_string())
                .ok_or_else(|| "usage: project remove <id|path|name>".to_string())?;
            Ok(Command::ProjectRemove { query })
        }
        "switch" => {
            let query = args
                .get(1)
                .filter(|a| !a.starts_with('-'))
                .map(|s| (*s).to_string())
                .ok_or_else(|| "usage: project switch <id|path|name>".to_string())?;
            Ok(Command::ProjectSwitch { query })
        }
        other => Err(format!("unknown project subcommand: {other}")),
    }
}

fn take_flag_value<'a>(
    args: &[&'a str],
    name: &str,
) -> Result<(Option<&'a str>, Vec<&'a str>), String> {
    let mut value = None;
    let mut rest = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == name {
            let v = args
                .get(i + 1)
                .copied()
                .ok_or_else(|| format!("missing value for {name}"))?;
            // Allow "-" (stdin); reject other flag-like tokens.
            if v.starts_with('-') && v != "-" {
                return Err(format!("missing value for {name}"));
            }
            value = Some(v);
            i += 2;
            continue;
        }
        rest.push(args[i]);
        i += 1;
    }
    Ok((value, rest))
}

fn parse_run(args: &[&str]) -> Result<Command, String> {
    let Some(sub) = args.first().copied() else {
        return Err("usage: run <list|get|upsert|remove|start|stop|status> ...".into());
    };
    let (project, rest) = take_flag_value(&args[1..], "--project")?;
    let project = project.map(|s| s.to_string());
    match sub {
        "list" => Ok(Command::RunList { project }),
        "get" => {
            let query = rest
                .first()
                .map(|s| (*s).to_string())
                .ok_or_else(|| "usage: run get <name|id> [--project ...]".to_string())?;
            Ok(Command::RunGet { query, project })
        }
        "upsert" => {
            let (json_source, _) = take_flag_value(&args[1..], "--json")?;
            let json_source = json_source
                .map(|s| s.to_string())
                .ok_or_else(|| "usage: run upsert --json <file|-> [--project ...]".to_string())?;
            Ok(Command::RunUpsert {
                json_source,
                project,
            })
        }
        "remove" | "rm" => {
            let query = rest
                .first()
                .map(|s| (*s).to_string())
                .ok_or_else(|| "usage: run remove <name|id> [--project ...]".to_string())?;
            Ok(Command::RunRemove { query, project })
        }
        "start" => {
            let query = rest
                .first()
                .map(|s| (*s).to_string())
                .ok_or_else(|| "usage: run start <name|id> [--project ...]".to_string())?;
            Ok(Command::RunStart { query, project })
        }
        "stop" => {
            let query = rest
                .first()
                .map(|s| (*s).to_string())
                .ok_or_else(|| "usage: run stop <name|id> [--project ...]".to_string())?;
            Ok(Command::RunStop { query, project })
        }
        "status" => Ok(Command::RunStatus { project }),
        other => Err(format!("unknown run subcommand: {other}")),
    }
}

fn parse_trust(args: &[&str]) -> Result<Command, String> {
    match args.first().copied() {
        Some("grant") => {
            let path = args
                .get(1)
                .filter(|a| !a.starts_with('-'))
                .map(|s| (*s).to_string())
                .ok_or_else(|| "usage: trust grant <path>".to_string())?;
            Ok(Command::TrustGrant { path })
        }
        _ => Err("usage: trust grant <path>".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        std::iter::once("qingcode.exe".to_string())
            .chain(parts.iter().map(|s| (*s).to_string()))
            .collect()
    }

    #[test]
    fn plain_file_args_are_not_cli() {
        assert!(parse(&args(&["D:\\a.ts"])).is_none());
    }

    #[test]
    fn settings_reset_requires_explicit_confirmation() {
        assert!(parse(&args(&["settings", "reset"])).unwrap().is_err());
        assert_eq!(
            parse(&args(&[
                "settings",
                "reset",
                "--yes",
                "--scope",
                "workspace",
                "--project",
                "D:\\a"
            ]))
            .unwrap()
            .unwrap(),
            Command::SettingsReset {
                scope: "workspace".into(),
                project: Some("D:\\a".into())
            }
        );
        for parts in [
            vec!["settings", "reset", "--yes", "--yes"],
            vec!["settings", "reset", "--yes", "--json", "-"],
            vec!["settings", "reset", "--yes", "--output", "a"],
            vec!["settings", "export", "--yes"],
        ] {
            assert!(parse(&args(&parts)).unwrap().is_err(), "{parts:?}");
        }
    }

    #[test]
    fn parses_settings_export_and_import() {
        assert_eq!(
            parse(&args(&["settings", "export"])).unwrap().unwrap(),
            Command::SettingsExport {
                scope: "user".into(),
                project: None,
                output: None
            }
        );
        assert_eq!(
            parse(&args(&[
                "settings",
                "import",
                "--scope",
                "workspace",
                "--project",
                "D:\\a",
                "--json",
                "-"
            ]))
            .unwrap()
            .unwrap(),
            Command::SettingsImport {
                scope: "workspace".into(),
                project: Some("D:\\a".into()),
                json_source: "-".into()
            }
        );
    }

    #[test]
    fn settings_rejects_ambiguous_or_invalid_arguments() {
        for parts in [
            vec!["settings", "import"],
            vec!["settings", "export", "--scope", "global"],
            vec!["settings", "export", "--project", "a"],
            vec!["settings", "import", "--json", "-", "--output", "a"],
            vec!["settings", "export", "--unknown", "a"],
            vec![
                "settings",
                "export",
                "--scope",
                "user",
                "--scope",
                "workspace",
            ],
            vec!["settings", "export", "--output"],
        ] {
            assert!(parse(&args(&parts)).unwrap().is_err(), "{parts:?}");
        }
    }

    #[test]
    fn parses_project_add_multiple() {
        let cmd = parse(&args(&["project", "add", "D:\\a", "D:\\b"]))
            .unwrap()
            .unwrap();
        assert_eq!(
            cmd,
            Command::ProjectAdd {
                paths: vec!["D:\\a".into(), "D:\\b".into()]
            }
        );
    }

    #[test]
    fn parses_run_upsert_json() {
        let cmd = parse(&args(&[
            "run",
            "upsert",
            "--project",
            "qingcode",
            "--json",
            "-",
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(
            cmd,
            Command::RunUpsert {
                json_source: "-".into(),
                project: Some("qingcode".into()),
            }
        );
    }
}
