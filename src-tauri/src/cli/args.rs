//! Minimal argv parser for `qingcode.exe` subcommands.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    Version,
    Status,
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
        task: Option<String>,
        wait: Option<RunWait>,
    },
    RunStop {
        query: String,
        project: Option<String>,
        task: Option<String>,
    },
    RunRestart {
        query: String,
        project: Option<String>,
        task: Option<String>,
    },
    RunLogs {
        query: String,
        project: Option<String>,
        task: Option<String>,
        tail: Option<u32>,
    },
    RunStatus {
        project: Option<String>,
    },
    TerminalProfiles,
    TerminalDiagnostics {
        query: String,
        project: Option<String>,
    },
    TerminalPrewarmStatus {
        project: Option<String>,
    },
    TerminalProfileGet {
        query: String,
    },
    TerminalProfileRemove {
        query: String,
    },
    TerminalProfileDefault {
        query: String,
    },
    TerminalProfileUpsert {
        json_source: String,
    },
    TerminalList {
        project: Option<String>,
    },
    TerminalRead {
        query: String,
        project: Option<String>,
        scope: Option<String>,
        tail: Option<u32>,
    },
    TerminalSend {
        query: String,
        project: Option<String>,
        input: TerminalInput,
        enter: bool,
    },
    TerminalCreate {
        project: Option<String>,
        profile: Option<String>,
        wait_secs: Option<u64>,
    },
    TerminalClose {
        query: String,
        project: Option<String>,
    },
    TerminalRestart {
        query: String,
        project: Option<String>,
    },
    TrustGrant {
        path: String,
    },
    TrustRevoke {
        path: String,
    },
    TrustList,
    Open {
        targets: Vec<String>,
    },
}

/// `run start --wait` 的等待条件；未指定文本时只等任务进程启动完成。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunWait {
    pub text: Option<String>,
    pub timeout_secs: u64,
}

/// `terminal send` 的输入来源；内容原样发送，不做任何转换。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalInput {
    None,
    Text(String),
    Stdin,
}

const ROOT_COMMANDS: &[&str] = &[
    "project", "run", "terminal", "settings", "trust", "open", "help", "version", "status",
];

const TERMINAL_USAGE: &str = "usage: terminal profiles | terminal profile get|default <id|name> | terminal profile upsert --json <file|-> | terminal profile remove <id|name> --yes | terminal prewarm status [--project ...] | terminal diagnostics <id|name> [--project ...] | terminal list [--project ...] | terminal create [--profile <id|name>] [--project ...] [--wait] [--timeout <seconds>] | terminal read <id|name> [--project ...] [--scope screen|buffer] [--tail <n>] | terminal send <id|name> [--project ...] [--text <text> | --stdin] [--enter] | terminal restart <id|name> [--project ...] | terminal close <id|name> --yes [--project ...]";
const RUN_START_USAGE: &str = "usage: run start <name|id> [--project ...] [--task <id|name>] [--wait] [--wait-text <text>] [--timeout <seconds>]";
const TRUST_USAGE: &str = "usage: trust grant <path> | trust revoke <path> | trust list";

const DEFAULT_WAIT_SECS: u64 = 60;
const MAX_WAIT_SECS: u64 = 3600;
const MAX_TAIL_LINES: u32 = 20_000;

/// Returns `Some` when argv is a CLI invocation (not plain GUI / open-with files).
pub fn parse(args: &[String]) -> Option<Result<Command, String>> {
    parse_with(args, |path| std::path::Path::new(path).exists())
}

fn parse_with(
    args: &[String],
    path_exists: impl Fn(&str) -> bool,
) -> Option<Result<Command, String>> {
    let rest: Vec<&str> = args.iter().skip(1).map(String::as_str).collect();
    if rest.is_empty() {
        return None;
    }
    let first = rest[0];
    if first == "-h" || first == "--help" || first == "help" {
        return Some(Ok(Command::Help));
    }
    if first == "-V" || first == "--version" {
        return Some(Ok(Command::Version));
    }
    if ROOT_COMMANDS.contains(&first) {
        return Some(parse_command(&rest));
    }
    if looks_like_launch_target(first, path_exists) {
        return None;
    }
    // 拼错的命令若落到启动 GUI，自动化调用会一直卡住，这里必须明确报错。
    Some(Err(format!("unknown command: {first}")))
}

/// 资源管理器“打开方式”和协议链接传入的都是路径或 URI；裸词只有对应真实文件时才算路径。
fn looks_like_launch_target(arg: &str, path_exists: impl Fn(&str) -> bool) -> bool {
    !arg.starts_with('-') && (arg.contains(['/', '\\', '.']) || path_exists(arg))
}

fn parse_command(rest: &[&str]) -> Result<Command, String> {
    match rest[0] {
        "help" => Ok(Command::Help),
        "version" => {
            parse_flags(&rest[1..], &NO_FLAGS)?.expect_positional(0, "usage: version")?;
            Ok(Command::Version)
        }
        "status" => {
            parse_flags(&rest[1..], &NO_FLAGS)?.expect_positional(0, "usage: status")?;
            Ok(Command::Status)
        }
        "project" => parse_project(&rest[1..]),
        "run" => parse_run(&rest[1..]),
        "terminal" => parse_terminal(&rest[1..]),
        "settings" => parse_settings(&rest[1..]),
        "trust" => parse_trust(&rest[1..]),
        "open" => parse_open(&rest[1..]),
        other => Err(format!("unknown command: {other}")),
    }
}

fn wants_help(args: &[&str]) -> bool {
    args.iter().any(|arg| *arg == "--help" || *arg == "-h")
}

/// 子命令接受的选项。未列出的 `-` 开头参数一律报错，避免拼错的选项被静默忽略。
struct FlagSpec {
    values: &'static [&'static str],
    /// 取值可以以 `-` 开头的选项（自由文本）。
    free_values: &'static [&'static str],
    switches: &'static [&'static str],
}

const NO_FLAGS: FlagSpec = FlagSpec {
    values: &[],
    free_values: &[],
    switches: &[],
};
const PROJECT_FLAG: FlagSpec = FlagSpec {
    values: &["--project"],
    free_values: &[],
    switches: &[],
};
const TASK_FLAGS: FlagSpec = FlagSpec {
    values: &["--project", "--task"],
    free_values: &[],
    switches: &[],
};

#[derive(Debug, Default)]
struct Flags<'a> {
    positional: Vec<&'a str>,
    values: std::collections::HashMap<&'static str, &'a str>,
    switches: std::collections::HashSet<&'static str>,
}

impl<'a> Flags<'a> {
    fn string(&self, name: &str) -> Option<String> {
        self.values.get(name).map(|value| (*value).to_string())
    }

    fn has(&self, name: &str) -> bool {
        self.switches.contains(name)
    }

    fn expect_positional(&self, count: usize, usage: &str) -> Result<&[&'a str], String> {
        if self.positional.len() == count {
            Ok(&self.positional)
        } else {
            Err(usage.to_string())
        }
    }

    fn single(&self, usage: &str) -> Result<String, String> {
        Ok(self.expect_positional(1, usage)?[0].to_string())
    }

    fn tail(&self) -> Result<Option<u32>, String> {
        let Some(raw) = self.values.get("--tail") else {
            return Ok(None);
        };
        match raw.parse::<u32>() {
            Ok(value) if (1..=MAX_TAIL_LINES).contains(&value) => Ok(Some(value)),
            _ => Err(format!("--tail must be between 1 and {MAX_TAIL_LINES}")),
        }
    }
}

fn parse_flags<'a>(args: &[&'a str], spec: &FlagSpec) -> Result<Flags<'a>, String> {
    let mut flags = Flags::default();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i];
        i += 1;
        if arg == "--" {
            flags.positional.extend_from_slice(&args[i..]);
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            flags.positional.push(arg);
            continue;
        }
        if let Some(name) = spec.switches.iter().find(|name| **name == arg) {
            if !flags.switches.insert(name) {
                return Err(format!("duplicate option: {arg}"));
            }
            continue;
        }
        let free = spec.free_values.iter().find(|name| **name == arg);
        let Some(name) = free.or_else(|| spec.values.iter().find(|name| **name == arg)) else {
            return Err(format!("unknown option: {arg}"));
        };
        let value = args
            .get(i)
            .copied()
            .filter(|value| free.is_some() || !value.starts_with('-') || *value == "-")
            .ok_or_else(|| format!("missing value for {arg}"))?;
        i += 1;
        if flags.values.insert(name, value).is_some() {
            return Err(format!("duplicate option: {arg}"));
        }
    }
    Ok(flags)
}

fn parse_open(args: &[&str]) -> Result<Command, String> {
    if wants_help(args) {
        return Ok(Command::Help);
    }
    let flags = parse_flags(args, &NO_FLAGS)?;
    if flags.positional.is_empty() {
        return Err("usage: open <file>[:line[:col]] ...".into());
    }
    Ok(Command::Open {
        targets: flags.positional.iter().map(|s| (*s).to_string()).collect(),
    })
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
    if wants_help(args) {
        return Ok(Command::Help);
    }
    let Some(sub) = args.first().copied() else {
        return Err("usage: project <list|add|remove|switch> ...".into());
    };
    let flags = parse_flags(&args[1..], &NO_FLAGS)?;
    match sub {
        "list" => {
            flags.expect_positional(0, "usage: project list")?;
            Ok(Command::ProjectList)
        }
        "add" => {
            if flags.positional.is_empty() {
                return Err("usage: project add <dir> [<dir>...]".into());
            }
            Ok(Command::ProjectAdd {
                paths: flags.positional.iter().map(|s| (*s).to_string()).collect(),
            })
        }
        "remove" | "rm" => Ok(Command::ProjectRemove {
            query: flags.single("usage: project remove <id|path|name>")?,
        }),
        "switch" => Ok(Command::ProjectSwitch {
            query: flags.single("usage: project switch <id|path|name>")?,
        }),
        other => Err(format!("unknown project subcommand: {other}")),
    }
}

fn parse_run(args: &[&str]) -> Result<Command, String> {
    if wants_help(args) {
        return Ok(Command::Help);
    }
    let Some(sub) = args.first().copied() else {
        return Err(
            "usage: run <list|get|upsert|remove|start|stop|restart|logs|status> ...".into(),
        );
    };
    let rest = &args[1..];
    match sub {
        "list" => {
            let flags = parse_flags(rest, &PROJECT_FLAG)?;
            flags.expect_positional(0, "usage: run list [--project ...]")?;
            Ok(Command::RunList {
                project: flags.string("--project"),
            })
        }
        "status" => {
            let flags = parse_flags(rest, &PROJECT_FLAG)?;
            flags.expect_positional(0, "usage: run status [--project ...]")?;
            Ok(Command::RunStatus {
                project: flags.string("--project"),
            })
        }
        "get" => {
            let flags = parse_flags(rest, &PROJECT_FLAG)?;
            Ok(Command::RunGet {
                query: flags.single("usage: run get <name|id> [--project ...]")?,
                project: flags.string("--project"),
            })
        }
        "upsert" => {
            const USAGE: &str = "usage: run upsert --json <file|-> [--project ...]";
            let flags = parse_flags(
                rest,
                &FlagSpec {
                    values: &["--project", "--json"],
                    free_values: &[],
                    switches: &[],
                },
            )?;
            flags.expect_positional(0, USAGE)?;
            Ok(Command::RunUpsert {
                json_source: flags.string("--json").ok_or(USAGE)?,
                project: flags.string("--project"),
            })
        }
        "remove" | "rm" => {
            let flags = parse_flags(rest, &PROJECT_FLAG)?;
            Ok(Command::RunRemove {
                query: flags.single("usage: run remove <name|id> [--project ...]")?,
                project: flags.string("--project"),
            })
        }
        "start" => parse_run_start(rest),
        "stop" => {
            let flags = parse_flags(rest, &TASK_FLAGS)?;
            Ok(Command::RunStop {
                query: flags.single("usage: run stop <name|id> [--project ...] [--task ...]")?,
                project: flags.string("--project"),
                task: flags.string("--task"),
            })
        }
        "restart" => {
            let flags = parse_flags(rest, &TASK_FLAGS)?;
            Ok(Command::RunRestart {
                query: flags.single("usage: run restart <name|id> [--project ...] [--task ...]")?,
                project: flags.string("--project"),
                task: flags.string("--task"),
            })
        }
        "logs" => {
            let flags = parse_flags(
                rest,
                &FlagSpec {
                    values: &["--project", "--task", "--tail"],
                    free_values: &[],
                    switches: &[],
                },
            )?;
            Ok(Command::RunLogs {
                query: flags.single(
                    "usage: run logs <name|id> [--project ...] [--task ...] [--tail <n>]",
                )?,
                project: flags.string("--project"),
                task: flags.string("--task"),
                tail: flags.tail()?,
            })
        }
        other => Err(format!("unknown run subcommand: {other}")),
    }
}

fn parse_run_start(args: &[&str]) -> Result<Command, String> {
    let flags = parse_flags(
        args,
        &FlagSpec {
            values: &["--project", "--task", "--timeout"],
            free_values: &["--wait-text"],
            switches: &["--wait"],
        },
    )?;
    let text = flags.string("--wait-text");
    if text.as_deref() == Some("") {
        return Err("--wait-text must not be empty".into());
    }
    let waiting = flags.has("--wait") || text.is_some();
    let timeout_secs = parse_wait_timeout(&flags, waiting)?;
    Ok(Command::RunStart {
        query: flags.single(RUN_START_USAGE)?,
        project: flags.string("--project"),
        task: flags.string("--task"),
        wait: timeout_secs.map(|timeout_secs| RunWait { text, timeout_secs }),
    })
}

fn parse_wait_timeout(flags: &Flags<'_>, waiting: bool) -> Result<Option<u64>, String> {
    let timeout = flags.values.get("--timeout").copied();
    if timeout.is_some() && !waiting {
        return Err("--timeout requires a wait option".into());
    }
    let timeout_secs = match timeout {
        None => DEFAULT_WAIT_SECS,
        Some(raw) => match raw.parse::<u64>() {
            Ok(value) if (1..=MAX_WAIT_SECS).contains(&value) => value,
            _ => return Err(format!("--timeout must be between 1 and {MAX_WAIT_SECS}")),
        },
    };
    Ok(waiting.then_some(timeout_secs))
}

fn parse_terminal_profile(args: &[&str]) -> Result<Command, String> {
    let Some((action, rest)) = args.split_first() else {
        return Err(TERMINAL_USAGE.into());
    };
    match *action {
        "get" | "default" => {
            let query = parse_flags(rest, &NO_FLAGS)?.single(TERMINAL_USAGE)?;
            Ok(if *action == "get" {
                Command::TerminalProfileGet { query }
            } else {
                Command::TerminalProfileDefault { query }
            })
        }
        "upsert" => {
            let flags = parse_flags(
                rest,
                &FlagSpec {
                    values: &["--json"],
                    ..NO_FLAGS
                },
            )?;
            flags.expect_positional(0, TERMINAL_USAGE)?;
            Ok(Command::TerminalProfileUpsert {
                json_source: flags.string("--json").ok_or(TERMINAL_USAGE)?,
            })
        }
        "remove" => {
            let flags = parse_flags(
                rest,
                &FlagSpec {
                    switches: &["--yes"],
                    ..NO_FLAGS
                },
            )?;
            if !flags.has("--yes") {
                return Err("terminal profile remove requires --yes".into());
            }
            Ok(Command::TerminalProfileRemove {
                query: flags.single(TERMINAL_USAGE)?,
            })
        }
        _ => Err(TERMINAL_USAGE.into()),
    }
}

fn parse_terminal(args: &[&str]) -> Result<Command, String> {
    let Some(sub) = args.first().copied() else {
        return Err(TERMINAL_USAGE.into());
    };
    if sub == "--help" || sub == "-h" {
        return Ok(Command::Help);
    }
    if sub == "send" {
        // `--text` 的内容可以是 `--help`，因此只看紧跟子命令的位置。
        if matches!(args.get(1).copied(), Some("--help" | "-h")) {
            return Ok(Command::Help);
        }
        return parse_terminal_send(&args[1..]);
    }
    if wants_help(args) {
        return Ok(Command::Help);
    }
    let rest = &args[1..];
    let usage = |_| TERMINAL_USAGE.to_string();
    match sub {
        "list" => {
            let flags = parse_flags(rest, &PROJECT_FLAG).map_err(usage)?;
            flags.expect_positional(0, TERMINAL_USAGE)?;
            Ok(Command::TerminalList {
                project: flags.string("--project"),
            })
        }
        "prewarm" => {
            let flags = parse_flags(rest, &PROJECT_FLAG)?;
            if flags.single(TERMINAL_USAGE)? != "status" {
                return Err(TERMINAL_USAGE.into());
            }
            Ok(Command::TerminalPrewarmStatus {
                project: flags.string("--project"),
            })
        }
        "diagnostics" => {
            let flags = parse_flags(rest, &PROJECT_FLAG)?;
            Ok(Command::TerminalDiagnostics {
                query: flags.single(TERMINAL_USAGE)?,
                project: flags.string("--project"),
            })
        }
        "profile" => parse_terminal_profile(rest),
        "profiles" => {
            parse_flags(rest, &NO_FLAGS)?.expect_positional(0, TERMINAL_USAGE)?;
            Ok(Command::TerminalProfiles)
        }
        "create" => {
            let flags = parse_flags(
                rest,
                &FlagSpec {
                    values: &["--project", "--profile", "--timeout"],
                    switches: &["--wait"],
                    ..NO_FLAGS
                },
            )?;
            flags.expect_positional(0, TERMINAL_USAGE)?;
            let profile = flags.string("--profile");
            if profile.as_deref().is_some_and(|q| q.trim().is_empty()) {
                return Err("missing value for --profile".into());
            }
            Ok(Command::TerminalCreate {
                project: flags.string("--project"),
                profile,
                wait_secs: parse_wait_timeout(&flags, flags.has("--wait"))?,
            })
        }
        "read" => {
            let flags = parse_flags(
                rest,
                &FlagSpec {
                    values: &["--project", "--scope", "--tail"],
                    free_values: &[],
                    switches: &[],
                },
            )?;
            let scope = flags.string("--scope");
            if scope
                .as_deref()
                .is_some_and(|value| value != "screen" && value != "buffer")
            {
                return Err("--scope must be screen or buffer".into());
            }
            Ok(Command::TerminalRead {
                query: flags.single(TERMINAL_USAGE)?,
                project: flags.string("--project"),
                scope,
                tail: flags.tail()?,
            })
        }
        "restart" => {
            let flags = parse_flags(rest, &PROJECT_FLAG).map_err(usage)?;
            Ok(Command::TerminalRestart {
                query: flags.single(TERMINAL_USAGE)?,
                project: flags.string("--project"),
            })
        }
        "close" => {
            let flags = parse_flags(
                rest,
                &FlagSpec {
                    values: &["--project"],
                    free_values: &[],
                    switches: &["--yes"],
                },
            )
            .map_err(usage)?;
            // 关闭会结束终端里的进程，和 settings reset 一样要求显式确认。
            if !flags.has("--yes") {
                return Err(TERMINAL_USAGE.into());
            }
            Ok(Command::TerminalClose {
                query: flags.single(TERMINAL_USAGE)?,
                project: flags.string("--project"),
            })
        }
        _ => Err(TERMINAL_USAGE.into()),
    }
}

fn parse_terminal_send(args: &[&str]) -> Result<Command, String> {
    let query = args
        .first()
        .filter(|a| !a.starts_with('-'))
        .map(|s| (*s).to_string())
        .ok_or_else(|| TERMINAL_USAGE.to_string())?;
    let mut project = None;
    let mut input = TerminalInput::None;
    let mut enter = false;
    let mut i = 1;
    while i < args.len() {
        match args[i] {
            "--enter" if !enter => enter = true,
            "--stdin" if input == TerminalInput::None => input = TerminalInput::Stdin,
            "--project" if project.is_none() => {
                let value = args
                    .get(i + 1)
                    .filter(|v| !v.starts_with('-'))
                    .ok_or_else(|| TERMINAL_USAGE.to_string())?;
                project = Some((*value).to_string());
                i += 1;
            }
            "--text" if input == TerminalInput::None => {
                // 文本可以以 `-` 开头（例如 `-h`），因此不校验内容。
                let value = args.get(i + 1).ok_or_else(|| TERMINAL_USAGE.to_string())?;
                input = TerminalInput::Text((*value).to_string());
                i += 1;
            }
            _ => return Err(TERMINAL_USAGE.into()),
        }
        i += 1;
    }
    let empty = match &input {
        TerminalInput::None => true,
        TerminalInput::Text(text) => text.is_empty(),
        TerminalInput::Stdin => false,
    };
    if empty && !enter {
        return Err(TERMINAL_USAGE.into());
    }
    Ok(Command::TerminalSend {
        query,
        project,
        input,
        enter,
    })
}

fn parse_trust(args: &[&str]) -> Result<Command, String> {
    if wants_help(args) {
        return Ok(Command::Help);
    }
    let Some(sub) = args.first().copied() else {
        return Err(TRUST_USAGE.into());
    };
    let flags = parse_flags(&args[1..], &NO_FLAGS).map_err(|_| TRUST_USAGE.to_string())?;
    match sub {
        "grant" => Ok(Command::TrustGrant {
            path: flags.single(TRUST_USAGE)?,
        }),
        "revoke" => Ok(Command::TrustRevoke {
            path: flags.single(TRUST_USAGE)?,
        }),
        "list" => {
            flags.expect_positional(0, TRUST_USAGE)?;
            Ok(Command::TrustList)
        }
        _ => Err(TRUST_USAGE.into()),
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
    fn parses_terminal_list() {
        assert_eq!(
            parse(&args(&["terminal", "list"])).unwrap().unwrap(),
            Command::TerminalList { project: None }
        );
        assert_eq!(
            parse(&args(&["terminal", "list", "--project", "ssh-demo"]))
                .unwrap()
                .unwrap(),
            Command::TerminalList {
                project: Some("ssh-demo".into())
            }
        );
    }

    #[test]
    fn parses_terminal_send_text_verbatim() {
        assert_eq!(
            parse(&args(&[
                "terminal",
                "send",
                "term-1",
                "--project",
                "demo",
                "--text",
                "-h \u{3}",
                "--enter"
            ]))
            .unwrap()
            .unwrap(),
            Command::TerminalSend {
                query: "term-1".into(),
                project: Some("demo".into()),
                input: TerminalInput::Text("-h \u{3}".into()),
                enter: true,
            }
        );
    }

    #[test]
    fn parses_terminal_send_stdin_and_enter_only() {
        assert_eq!(
            parse(&args(&["terminal", "send", "t", "--stdin"]))
                .unwrap()
                .unwrap(),
            Command::TerminalSend {
                query: "t".into(),
                project: None,
                input: TerminalInput::Stdin,
                enter: false,
            }
        );
        assert_eq!(
            parse(&args(&["terminal", "send", "t", "--enter"]))
                .unwrap()
                .unwrap(),
            Command::TerminalSend {
                query: "t".into(),
                project: None,
                input: TerminalInput::None,
                enter: true,
            }
        );
    }

    #[test]
    fn terminal_rejects_ambiguous_or_empty_arguments() {
        for parts in [
            vec!["terminal"],
            vec!["terminal", "bogus", "t"],
            vec!["terminal", "close", "t"],
            vec!["terminal", "read", "t", "--scope", "all"],
            vec!["terminal", "read", "t", "--tail", "0"],
            vec!["terminal", "list", "--project"],
            vec!["terminal", "list", "extra"],
            vec!["terminal", "send"],
            vec!["terminal", "send", "--text", "x"],
            vec!["terminal", "send", "t"],
            vec!["terminal", "send", "t", "--text", ""],
            vec!["terminal", "send", "t", "--text"],
            vec!["terminal", "send", "t", "--text", "a", "--stdin"],
            vec!["terminal", "send", "t", "--stdin", "--stdin"],
            vec!["terminal", "send", "t", "--enter", "--enter"],
            vec!["terminal", "send", "t", "--enter", "--project"],
            vec!["terminal", "send", "t", "--enter", "--unknown"],
        ] {
            assert!(parse(&args(&parts)).unwrap().is_err(), "{parts:?}");
        }
    }

    #[test]
    fn plain_file_args_are_not_cli() {
        assert!(parse(&args(&["D:\\a.ts"])).is_none());
    }

    #[test]
    fn unknown_root_tokens_fail_instead_of_launching_the_gui() {
        let nothing_exists = |_: &str| false;
        for parts in [vec!["projct", "list"], vec!["--bogus"], vec!["-x"]] {
            assert!(
                parse_with(&args(&parts), nothing_exists).unwrap().is_err(),
                "{parts:?}"
            );
        }
        for parts in [vec!["a.ts"], vec!["src/a"], vec!["qingcode://open"]] {
            assert!(
                parse_with(&args(&parts), nothing_exists).is_none(),
                "{parts:?}"
            );
        }
        assert!(parse_with(&args(&["README"]), |_| true).is_none());
        assert!(parse_with(&args(&[]), nothing_exists).is_none());
    }

    #[test]
    fn version_and_status_are_cli_commands() {
        for parts in [vec!["--version"], vec!["-V"], vec!["version"]] {
            assert_eq!(parse(&args(&parts)).unwrap().unwrap(), Command::Version);
        }
        assert_eq!(parse(&args(&["status"])).unwrap().unwrap(), Command::Status);
        assert!(parse(&args(&["status", "extra"])).unwrap().is_err());
    }

    #[test]
    fn subcommand_help_is_not_a_usage_error() {
        for parts in [
            vec!["run", "--help"],
            vec!["run", "start", "-h"],
            vec!["project", "--help"],
            vec!["terminal", "--help"],
            vec!["terminal", "send", "--help"],
            vec!["trust", "--help"],
            vec!["open", "--help"],
        ] {
            assert_eq!(
                parse(&args(&parts)).unwrap().unwrap(),
                Command::Help,
                "{parts:?}"
            );
        }
    }

    #[test]
    fn terminal_send_text_may_literally_be_help() {
        assert_eq!(
            parse(&args(&["terminal", "send", "t", "--text", "--help"]))
                .unwrap()
                .unwrap(),
            Command::TerminalSend {
                query: "t".into(),
                project: None,
                input: TerminalInput::Text("--help".into()),
                enter: false,
            }
        );
    }

    #[test]
    fn misspelled_or_extra_arguments_never_fall_back_to_defaults() {
        for parts in [
            vec!["run", "start", "dev", "--projct", "other"],
            vec!["run", "list", "--projct", "other"],
            vec!["run", "status", "--bogus"],
            vec!["run", "get", "a", "b"],
            vec!["run", "upsert", "--json", "-", "--json", "x"],
            vec!["run", "upsert", "--json", "-", "stray"],
            vec!["run", "stop", "dev", "--project", "a", "--project", "b"],
            vec!["project", "list", "--bogus"],
            vec!["project", "add", "--force", "D:\\a"],
            vec!["project", "remove", "a", "b"],
            vec!["open", "--line", "10", "a.ts"],
            vec!["trust", "grant", "a", "b"],
            vec!["trust", "grant", "--bogus", "a"],
        ] {
            assert!(parse(&args(&parts)).unwrap().is_err(), "{parts:?}");
        }
    }

    #[test]
    fn double_dash_allows_targets_that_start_with_a_dash() {
        assert_eq!(
            parse(&args(&["open", "--", "-odd.ts"])).unwrap().unwrap(),
            Command::Open {
                targets: vec!["-odd.ts".into()]
            }
        );
    }

    #[test]
    fn run_start_wait_options() {
        assert_eq!(
            parse(&args(&["run", "start", "dev"])).unwrap().unwrap(),
            Command::RunStart {
                query: "dev".into(),
                project: None,
                task: None,
                wait: None,
            }
        );
        assert_eq!(
            parse(&args(&[
                "run",
                "start",
                "dev",
                "--task",
                "api",
                "--wait-text",
                "-> ready",
                "--timeout",
                "90"
            ]))
            .unwrap()
            .unwrap(),
            Command::RunStart {
                query: "dev".into(),
                project: None,
                task: Some("api".into()),
                wait: Some(RunWait {
                    text: Some("-> ready".into()),
                    timeout_secs: 90,
                }),
            }
        );
        assert_eq!(
            parse(&args(&["run", "start", "dev", "--wait"]))
                .unwrap()
                .unwrap(),
            Command::RunStart {
                query: "dev".into(),
                project: None,
                task: None,
                wait: Some(RunWait {
                    text: None,
                    timeout_secs: DEFAULT_WAIT_SECS,
                }),
            }
        );
        for parts in [
            vec!["run", "start", "dev", "--timeout", "5"],
            vec!["run", "start", "dev", "--wait", "--timeout", "0"],
            vec!["run", "start", "dev", "--wait", "--timeout", "abc"],
            vec!["run", "start", "dev", "--wait-text", ""],
            vec!["run", "start", "--wait"],
        ] {
            assert!(parse(&args(&parts)).unwrap().is_err(), "{parts:?}");
        }
    }

    #[test]
    fn run_logs_and_restart_options() {
        assert_eq!(
            parse(&args(&[
                "run", "logs", "dev", "--task", "api", "--tail", "50"
            ]))
            .unwrap()
            .unwrap(),
            Command::RunLogs {
                query: "dev".into(),
                project: None,
                task: Some("api".into()),
                tail: Some(50),
            }
        );
        assert!(parse(&args(&["run", "logs", "dev", "--tail", "99999"]))
            .unwrap()
            .is_err());
        assert_eq!(
            parse(&args(&["run", "restart", "dev", "--project", "p"]))
                .unwrap()
                .unwrap(),
            Command::RunRestart {
                query: "dev".into(),
                project: Some("p".into()),
                task: None,
            }
        );
    }

    #[test]
    fn terminal_inspection_and_profile_flags_are_strict() {
        for valid in [
            vec!["terminal", "prewarm", "status", "--project", "p"],
            vec!["terminal", "diagnostics", "t"],
            vec!["terminal", "profile", "get", "default"],
            vec!["terminal", "profile", "default", "other"],
            vec!["terminal", "profile", "remove", "other", "--yes"],
            vec!["terminal", "profile", "upsert", "--json", "-"],
        ] {
            assert!(parse(&args(&valid)).unwrap().is_ok());
        }
        for invalid in [
            vec!["terminal", "prewarm", "clear"],
            vec!["terminal", "diagnostics"],
            vec!["terminal", "profile", "remove", "other"],
            vec!["terminal", "profile", "upsert"],
            vec!["terminal", "create", "--timeout", "1"],
            vec!["terminal", "create", "--wait", "--timeout", "0"],
        ] {
            assert!(parse(&args(&invalid)).unwrap().is_err());
        }
        assert_eq!(
            parse(&args(&["terminal", "create", "--wait", "--timeout", "2"]))
                .unwrap()
                .unwrap(),
            Command::TerminalCreate {
                project: None,
                profile: None,
                wait_secs: Some(2)
            }
        );
    }

    #[test]
    fn terminal_management_commands() {
        assert_eq!(
            parse(&args(&[
                "terminal", "read", "t", "--scope", "screen", "--tail", "20"
            ]))
            .unwrap()
            .unwrap(),
            Command::TerminalRead {
                query: "t".into(),
                project: None,
                scope: Some("screen".into()),
                tail: Some(20),
            }
        );
        assert_eq!(
            parse(&args(&["terminal", "create", "--project", "p"]))
                .unwrap()
                .unwrap(),
            Command::TerminalCreate {
                project: Some("p".into()),
                profile: None,
                wait_secs: None,
            }
        );
        assert_eq!(
            parse(&args(&["terminal", "profiles"])).unwrap().unwrap(),
            Command::TerminalProfiles
        );
        assert_eq!(
            parse(&args(&[
                "terminal",
                "create",
                "--profile",
                "Open Code",
                "--project",
                "p"
            ]))
            .unwrap()
            .unwrap(),
            Command::TerminalCreate {
                project: Some("p".into()),
                wait_secs: None,
                profile: Some("Open Code".into())
            }
        );
        for invalid in [
            vec!["terminal", "create", "--profile"],
            vec!["terminal", "create", "--profile", " "],
            vec!["terminal", "profiles", "--project", "p"],
        ] {
            assert!(parse(&args(&invalid)).unwrap().is_err());
        }
        assert_eq!(
            parse(&args(&["terminal", "close", "t", "--yes"]))
                .unwrap()
                .unwrap(),
            Command::TerminalClose {
                query: "t".into(),
                project: None,
            }
        );
        assert_eq!(
            parse(&args(&["terminal", "restart", "t"]))
                .unwrap()
                .unwrap(),
            Command::TerminalRestart {
                query: "t".into(),
                project: None,
            }
        );
    }

    #[test]
    fn trust_list_and_revoke() {
        assert_eq!(
            parse(&args(&["trust", "list"])).unwrap().unwrap(),
            Command::TrustList
        );
        assert_eq!(
            parse(&args(&["trust", "revoke", "D:\\a"]))
                .unwrap()
                .unwrap(),
            Command::TrustRevoke {
                path: "D:\\a".into()
            }
        );
        assert!(parse(&args(&["trust", "list", "extra"])).unwrap().is_err());
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
