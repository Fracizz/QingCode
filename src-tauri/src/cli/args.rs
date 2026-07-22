//! Minimal argv parser for `qingcode.exe` subcommands.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    ProjectList,
    ProjectAdd { paths: Vec<String> },
    ProjectRemove { query: String },
    ProjectSwitch { query: String },
    RunList { project: Option<String> },
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
    RunStatus { project: Option<String> },
    TrustGrant { path: String },
    Open { targets: Vec<String> },
}

const ROOT_COMMANDS: &[&str] = &["project", "run", "trust", "open", "help"];

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

fn take_flag_value<'a>(args: &[&'a str], name: &str) -> Result<(Option<&'a str>, Vec<&'a str>), String> {
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
