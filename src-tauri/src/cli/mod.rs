//! `qingcode.exe` subcommands for AI / automation.

mod args;
mod db;
mod online;
mod output;
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
            output::ok(json!({ "added": added, "errors": errors }))
        }
        Command::ProjectRemove { query } => {
            match db::open_db().and_then(|c| db::remove_project(&c, &query)) {
                Ok(removed) => output::ok(json!({ "removed": removed })),
                Err(e) => output::fail(output::EXIT_ERROR, e),
            }
        }
        Command::ProjectSwitch { query } => online::project_switch(&query),
        Command::RunList { project } => match run_config::list(project.as_deref()) {
            Ok(data) => output::ok(data),
            Err(e) => output::fail(output::EXIT_ERROR, e),
        },
        Command::RunGet { query, project } => match run_config::get(&query, project.as_deref()) {
            Ok(data) => output::ok(data),
            Err(e) => output::fail(output::EXIT_ERROR, e),
        },
        Command::RunUpsert {
            json_source,
            project,
        } => match run_config::upsert(&json_source, project.as_deref()) {
            Ok(data) => output::ok(data),
            Err(e) => output::fail(output::EXIT_ERROR, e),
        },
        Command::RunRemove { query, project } => {
            match run_config::remove(&query, project.as_deref()) {
                Ok(data) => output::ok(data),
                Err(e) => output::fail(output::EXIT_ERROR, e),
            }
        }
        Command::RunStart { query, project } => online::run_start(&query, project.as_deref()),
        Command::RunStop { query, project } => online::run_stop(&query, project.as_deref()),
        Command::RunStatus { project } => online::run_status(project.as_deref()),
        Command::TrustGrant { path } => online::trust_grant(&path),
        Command::Open { targets } => online::open(&targets),
    }
}
