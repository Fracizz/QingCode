//! `qingcode.exe` subcommands for AI / automation.

mod args;
mod db;
mod online;
mod output;
mod paths;
mod run_config;

use args::Command;
use serde_json::json;
use std::path::PathBuf;

/// If argv is a CLI invocation, run it and return an exit code. Otherwise `None` (start GUI).
pub fn try_run_as_cli() -> Option<i32> {
    let argv: Vec<String> = std::env::args().collect();
    let parsed = args::parse(&argv)?;
    output::ensure_stdio();
    Some(match parsed {
        Ok(cmd) => execute(cmd),
        Err(msg) => {
            let _ = output::usage(msg);
            output::write_help_hint();
            output::EXIT_USAGE
        }
    })
}

fn execute(cmd: Command) -> i32 {
    match cmd {
        Command::Help => {
            output::write_line_stdout(output::help_text().trim_end());
            output::EXIT_OK
        }
        Command::Version => online::version(),
        Command::Status => online::status(),
        Command::ProjectList => match db::open_db().and_then(|c| db::list_projects(&c)) {
            Ok(projects) => output::ok(json!({ "projects": projects, "count": projects.len() })),
            Err(e) => output::fail(output::EXIT_ERROR, e),
        },
        Command::ProjectAdd { paths } => {
            let conn = match db::open_db() {
                Ok(c) => c,
                Err(e) => return output::fail(output::EXIT_ERROR, e),
            };
            let mut added = Vec::new();
            let mut errors = Vec::new();
            for p in paths {
                match db::insert_project(&conn, &PathBuf::from(&p)) {
                    Ok(row) => added.push(row),
                    Err(e) => errors.push(json!({ "path": p, "error": e })),
                }
            }
            if added.is_empty() && !errors.is_empty() {
                return output::fail(
                    output::EXIT_ERROR,
                    format!("failed to add projects: {errors:?}"),
                );
            }
            let gui = online::notify_projects_changed();
            output::ok(json!({ "added": added, "errors": errors, "gui": gui }))
        }
        Command::ProjectRemove { query } => {
            match db::open_db().and_then(|c| db::remove_project(&c, &query)) {
                Ok(removed) => {
                    let gui = online::notify_projects_changed();
                    output::ok(json!({ "removed": removed, "gui": gui }))
                }
                Err(e) => output::fail(output::EXIT_ERROR, e),
            }
        }
        Command::ProjectSwitch { query } => online::project_switch(&query),
        Command::SettingsReset { scope, project } => {
            online::settings_reset(&scope, project.as_deref())
        }
        Command::SettingsExport {
            scope,
            project,
            output,
        } => online::settings_export(&scope, project.as_deref(), output.as_deref()),
        Command::SettingsImport {
            scope,
            project,
            json_source,
        } => match run_config::read_json_source(&json_source) {
            Ok(content) => online::settings_import(&scope, project.as_deref(), content),
            Err(e) => output::fail(output::EXIT_ERROR, e),
        },
        Command::RunList { project } => match run_config::remote_project_id(project.as_deref()) {
            Ok(Some(project_id)) => online::run_list(Some(&project_id)),
            Ok(None) => match run_config::list(project.as_deref()) {
                Ok(data) => output::ok(data),
                Err(e) => output::fail(output::EXIT_ERROR, e),
            },
            Err(e) => output::fail(output::EXIT_ERROR, e),
        },
        Command::RunGet { query, project } => {
            match run_config::remote_project_id(project.as_deref()) {
                Ok(Some(project_id)) => online::run_get(&query, Some(&project_id)),
                Ok(None) => match run_config::get(&query, project.as_deref()) {
                    Ok(data) => output::ok(data),
                    Err(e) => output::fail(output::EXIT_ERROR, e),
                },
                Err(e) => output::fail(output::EXIT_ERROR, e),
            }
        }
        Command::RunUpsert {
            json_source,
            project,
        } => match run_config::remote_project_id(project.as_deref()) {
            Ok(Some(project_id)) => match run_config::read_json_source(&json_source) {
                Ok(content) => online::run_upsert(content, Some(&project_id)),
                Err(e) => output::fail(output::EXIT_ERROR, e),
            },
            Ok(None) => match run_config::upsert(&json_source, project.as_deref()) {
                Ok(data) => ok_after_run_config_write(data),
                Err(e) => output::fail(output::EXIT_ERROR, e),
            },
            Err(e) => output::fail(output::EXIT_ERROR, e),
        },
        Command::RunRemove { query, project } => {
            match run_config::remote_project_id(project.as_deref()) {
                Ok(Some(project_id)) => online::run_remove(&query, Some(&project_id)),
                Ok(None) => match run_config::remove(&query, project.as_deref()) {
                    Ok(data) => ok_after_run_config_write(data),
                    Err(e) => output::fail(output::EXIT_ERROR, e),
                },
                Err(e) => output::fail(output::EXIT_ERROR, e),
            }
        }
        Command::RunStart {
            query,
            project,
            task,
            wait,
        } => online::run_start(&query, project.as_deref(), task.as_deref(), wait),
        Command::RunStop {
            query,
            project,
            task,
        } => online::run_stop(&query, project.as_deref(), task.as_deref()),
        Command::RunRestart {
            query,
            project,
            task,
        } => online::run_restart(&query, project.as_deref(), task.as_deref()),
        Command::RunLogs {
            query,
            project,
            task,
            tail,
        } => online::run_logs(&query, project.as_deref(), task.as_deref(), tail),
        Command::RunStatus { project } => online::run_status(project.as_deref()),
        Command::TerminalProfiles => online::terminal_profiles(),
        Command::TerminalList { project } => online::terminal_list(project.as_deref()),
        Command::TerminalRead {
            query,
            project,
            scope,
            tail,
        } => online::terminal_read(&query, project.as_deref(), scope.as_deref(), tail),
        Command::TerminalCreate { project, profile } => {
            online::terminal_create(project.as_deref(), profile.as_deref())
        }
        Command::TerminalClose { query, project } => {
            online::terminal_close(&query, project.as_deref())
        }
        Command::TerminalRestart { query, project } => {
            online::terminal_restart(&query, project.as_deref())
        }
        Command::TerminalSend {
            query,
            project,
            input,
            enter,
        } => {
            let text = match input {
                args::TerminalInput::None => String::new(),
                args::TerminalInput::Text(text) => text,
                args::TerminalInput::Stdin => match run_config::read_json_source("-") {
                    Ok(text) => text,
                    Err(error) => return output::fail(output::EXIT_ERROR, error),
                },
            };
            online::terminal_send(
                &query,
                project.as_deref(),
                online::terminal_payload(text, enter),
            )
        }
        Command::TrustGrant { path } => online::trust_grant(&path),
        Command::TrustRevoke { path } => online::trust_revoke(&path),
        Command::TrustList => online::trust_list(),
        Command::Open { targets } => online::open(&targets),
    }
}

fn ok_after_run_config_write(mut data: serde_json::Value) -> i32 {
    let project_id = data["project"]["id"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    data["gui"] = json!(online::notify_run_configs_changed(&project_id));
    output::ok(data)
}
