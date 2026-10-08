//! Online commands: talk to a running QingCode GUI via local IPC.

use super::output::{self, EXIT_APP_NOT_RUNNING, EXIT_ERROR};
use crate::ipc::{self, IpcRequest};
use serde_json::json;

pub fn settings_reset(scope: &str, project: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "settings.reset".into(),
        project: project.map(str::to_string),
        config: Some(scope.to_string()),
        path: None,
        paths: None,
        content: None,
    })
}

pub fn settings_import(scope: &str, project: Option<&str>, content: String) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "settings.import".into(),
        project: project.map(str::to_string),
        config: Some(scope.to_string()),
        path: None,
        paths: None,
        content: Some(content),
    })
}

pub fn settings_export(scope: &str, project: Option<&str>, destination: Option<&str>) -> i32 {
    let req = IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "settings.export".into(),
        project: project.map(str::to_string),
        config: Some(scope.to_string()),
        path: None,
        paths: None,
        content: None,
    };
    match ipc::client_request(&req) {
        Ok(resp) if resp.ok => {
            let data = resp.data.unwrap_or(serde_json::Value::Null);
            if let Some(destination) = destination {
                // Do not overwrite an existing file from an automation command.
                let result = (|| -> Result<(), String> {
                    use std::io::Write;
                    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
                    let mut file = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(destination)
                        .map_err(|e| format!("create {destination}: {e}"))?;
                    writeln!(file, "{content}").map_err(|e| format!("write {destination}: {e}"))
                })();
                if let Err(e) = result {
                    return output::fail(EXIT_ERROR, e);
                }
                output::ok(json!({ "path": destination, "scope": scope }))
            } else {
                output::ok(data)
            }
        }
        Ok(resp) => output::fail(
            EXIT_ERROR,
            resp.error.unwrap_or_else(|| "request failed".into()),
        ),
        Err(ipc::ClientError::AppNotRunning(msg)) => output::fail(EXIT_APP_NOT_RUNNING, msg),
        Err(ipc::ClientError::Other(msg)) => output::fail(EXIT_ERROR, msg),
    }
}

pub fn project_switch(query: &str) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "project.switch".into(),
        project: Some(query.to_string()),
        config: None,
        path: None,
        paths: None,
        content: None,
    })
}

pub fn run_start(query: &str, project: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "run.start".into(),
        project: project.map(|s| s.to_string()),
        config: Some(query.to_string()),
        path: None,
        paths: None,
        content: None,
    })
}

pub fn run_stop(query: &str, project: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "run.stop".into(),
        project: project.map(|s| s.to_string()),
        config: Some(query.to_string()),
        path: None,
        paths: None,
        content: None,
    })
}

pub fn run_status(project: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "run.status".into(),
        project: project.map(|s| s.to_string()),
        config: None,
        path: None,
        paths: None,
        content: None,
    })
}

pub fn run_list(project: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "run.list".into(),
        project: project.map(str::to_string),
        config: None,
        path: None,
        paths: None,
        content: None,
    })
}

pub fn run_get(query: &str, project: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "run.get".into(),
        project: project.map(str::to_string),
        config: Some(query.to_string()),
        path: None,
        paths: None,
        content: None,
    })
}

pub fn run_upsert(content: String, project: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "run.upsert".into(),
        project: project.map(str::to_string),
        config: None,
        path: None,
        paths: None,
        content: Some(content),
    })
}

pub fn run_remove(query: &str, project: Option<&str>) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "run.remove".into(),
        project: project.map(str::to_string),
        config: Some(query.to_string()),
        path: None,
        paths: None,
        content: None,
    })
}

pub fn trust_grant(path: &str) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "trust.grant".into(),
        project: None,
        config: None,
        path: Some(path.to_string()),
        paths: None,
        content: None,
    })
}

pub fn open(targets: &[String]) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "open".into(),
        project: None,
        config: None,
        path: None,
        paths: Some(targets.to_vec()),
        content: None,
    })
}

fn dispatch(req: IpcRequest) -> i32 {
    match ipc::client_request(&req) {
        Ok(resp) => {
            if resp.ok {
                output::print_json(&json!({
                    "ok": true,
                    "data": resp.data,
                }));
                output::EXIT_OK
            } else {
                output::fail(
                    EXIT_ERROR,
                    resp.error.unwrap_or_else(|| "request failed".into()),
                )
            }
        }
        Err(ipc::ClientError::AppNotRunning(msg)) => output::fail(EXIT_APP_NOT_RUNNING, msg),
        Err(ipc::ClientError::Other(msg)) => output::fail(EXIT_ERROR, msg),
    }
}
