//! Online commands: talk to a running QingCode GUI via local IPC.

use super::output::{self, EXIT_APP_NOT_RUNNING, EXIT_ERROR};
use crate::ipc::{self, IpcRequest};
use serde_json::json;

pub fn project_switch(query: &str) -> i32 {
    dispatch(IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        op: "project.switch".into(),
        project: Some(query.to_string()),
        config: None,
        path: None,
        paths: None,
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
